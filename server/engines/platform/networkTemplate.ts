import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NetworkTemplateInput, NetworkTemplateResult } from './types'

export const REDIS_PING_TEMPLATE_ID = 'sakuda-redis-unauthenticated-ping-v1'

/** Fixed, reviewed template. No caller-controlled template path or request data. */
export const REDIS_PING_TEMPLATE = `id: ${REDIS_PING_TEMPLATE_ID}

info:
  name: Redis unauthenticated PING response
  author: sakuda
  severity: info
  description: Checks only whether PING returns PONG; it does not request Redis data.

tcp:
  - host:
      - "{{Hostname}}"
    inputs:
      - data: "50494e470d0a"
        type: hex
    read-size: 64
    matchers:
      - name: unauthenticated-ping
        type: word
        words:
          - "+PONG"
      - name: authentication-required
        type: word
        words:
          - "-NOAUTH"
    matchers-condition: or
`

export function buildRedisNucleiArgs(
  endpoint: string,
  template: string,
  output: string,
  timeoutSeconds = 3,
): string[] {
  return [
    '-u',
    endpoint,
    '-t',
    template,
    '-o',
    output,
    '-pt',
    'tcp',
    '-duc',
    '-no-mhe',
    '-ni',
    '-nh',
    '-no-stdin',
    '-rl',
    '1',
    '-bs',
    '1',
    '-c',
    '1',
    '-pc',
    '1',
    '-timeout',
    String(Math.max(1, Math.ceil(timeoutSeconds))),
    '-retries',
    '0',
    '-or',
    '-jsonl',
  ]
}

function endpoint(address: string, port: number): string {
  return `${address.includes(':') ? `[${address}]` : address}:${port}`
}

async function spawnNuclei(
  input: NetworkTemplateInput,
  args: string[],
  cwd: string,
): Promise<number | null> {
  if (input.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
  return await new Promise((resolve, reject) => {
    const isolatedHome = join(cwd, 'home')
    const child = spawn(input.nucleiBin, args, {
      cwd,
      detached: true,
      shell: false,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: isolatedHome,
        XDG_CONFIG_HOME: join(isolatedHome, '.config'),
        XDG_CACHE_HOME: join(isolatedHome, '.cache'),
        TMPDIR: cwd,
        NO_COLOR: '1',
        DISABLE_NUCLEI_TEMPLATES_PUBLIC_DOWNLOAD: 'true',
      },
    })
    let settled = false
    let terminationError: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const terminate = (error: Error): void => {
      if (terminationError) return
      terminationError = error
      if (!child.pid) return
      try {
        process.kill(-child.pid, 'SIGTERM')
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL')
          } catch {
            /* already exited */
          }
        }, 500).unref()
      } catch {
        /* already exited */
      }
    }
    const finish = (error?: Error, code?: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(killTimer)
      input.signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(code ?? null)
    }
    const abort = (): void => {
      terminate(new DOMException('The operation was aborted', 'AbortError'))
    }
    const deadline = setTimeout(() => {
      terminate(new Error('nuclei timed out'))
    }, input.timeoutMs)
    child.once('error', (error) => finish(error))
    child.once('close', (code) => finish(terminationError, code))
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) abort()
  })
}

function normalizedEndpoint(value: string): string {
  const bare = value.replace(/^tcp:\/\//, '')
  if (bare.startsWith('[')) return bare
  const lastColon = bare.lastIndexOf(':')
  if (lastColon > 0 && bare.slice(0, lastColon).includes(':'))
    return `[${bare.slice(0, lastColon)}]${bare.slice(lastColon)}`
  return bare
}

export function parseRedisNucleiOutput(
  jsonl: string,
  expectedEndpoint: string,
): NetworkTemplateResult {
  const lines = jsonl.split('\n').filter((line) => line.trim().length > 0)
  let sawPong = false
  let sawNoAuth = false
  for (const line of lines) {
    let value: { 'template-id'?: unknown; 'matcher-name'?: unknown; 'matched-at'?: unknown }
    try {
      value = JSON.parse(line) as typeof value
    } catch {
      return { completed: false, matched: false }
    }
    if (
      value['template-id'] !== REDIS_PING_TEMPLATE_ID ||
      typeof value['matched-at'] !== 'string' ||
      normalizedEndpoint(value['matched-at']) !== normalizedEndpoint(expectedEndpoint)
    )
      return { completed: false, matched: false }
    if (value['matcher-name'] === 'unauthenticated-ping') sawPong = true
    else if (value['matcher-name'] === 'authentication-required') sawNoAuth = true
    else return { completed: false, matched: false }
  }
  return { completed: sawPong || sawNoAuth, matched: sawPong }
}

export async function runRedisPingTemplate(
  input: NetworkTemplateInput,
): Promise<NetworkTemplateResult> {
  const workDir = await mkdtemp(join(tmpdir(), 'sakuda-platform-'))
  const templatePath = join(workDir, 'redis-ping.yaml')
  const outputPath = join(workDir, 'result.jsonl')
  try {
    await chmod(workDir, 0o700)
    await mkdir(join(workDir, 'home'), { mode: 0o700 })
    await writeFile(templatePath, REDIS_PING_TEMPLATE, { mode: 0o600 })
    await writeFile(outputPath, '', { mode: 0o600 })
    const pinnedEndpoint = endpoint(input.address, input.port)
    const code = await spawnNuclei(
      input,
      buildRedisNucleiArgs(pinnedEndpoint, templatePath, outputPath, input.timeoutMs / 1000),
      workDir,
    )
    if (code !== 0) return { completed: false, matched: false }
    const outputStat = await stat(outputPath).catch(() => null)
    if (!outputStat) return { completed: false, matched: false }
    if (outputStat.size > 64 * 1024) return { completed: false, matched: false }
    return parseRedisNucleiOutput(await readFile(outputPath, 'utf8'), pinnedEndpoint)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return { completed: false, matched: false }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
