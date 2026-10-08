import { EventEmitter } from 'node:events'
import { statSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

// Mock setup must precede the module under test.
// eslint-disable-next-line import/first
import {
  buildRedisNucleiArgs,
  parseRedisNucleiOutput,
  REDIS_PING_TEMPLATE,
  REDIS_PING_TEMPLATE_ID,
  runRedisPingTemplate,
} from '../networkTemplate'

describe('approved Redis network template', () => {
  it('is immutable request content limited to PING and a bounded response', () => {
    expect(REDIS_PING_TEMPLATE).toContain(`id: ${REDIS_PING_TEMPLATE_ID}`)
    expect(REDIS_PING_TEMPLATE).toContain('host:\n      - "{{Hostname}}"')
    expect(REDIS_PING_TEMPLATE).not.toMatch(/^\s+port:/m)
    expect(REDIS_PING_TEMPLATE).toContain('50494e470d0a')
    expect(REDIS_PING_TEMPLATE).toContain('read-size: 64')
    expect(REDIS_PING_TEMPLATE).toContain('name: authentication-required')
    const requestData = [...REDIS_PING_TEMPLATE.matchAll(/^\s+- data: "([0-9a-f]+)"$/gim)].map(
      (match) => match[1],
    )
    expect(requestData).toEqual(['50494e470d0a'])
  })

  it('pins IPv6 input and uses the complete low-impact fixed flag set', () => {
    const args = buildRedisNucleiArgs('[2001:db8::10]:6379', '/t.yaml', '/result.jsonl')
    expect(args.slice(0, 6)).toEqual([
      '-u',
      '[2001:db8::10]:6379',
      '-t',
      '/t.yaml',
      '-o',
      '/result.jsonl',
    ])
    expect(args).toEqual(
      expect.arrayContaining([
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
        '3',
        '-retries',
        '0',
        '-or',
        '-jsonl',
      ]),
    )
  })

  it('accepts only recognized matcher output for the exact pinned endpoint', () => {
    const pong = JSON.stringify({
      'template-id': REDIS_PING_TEMPLATE_ID,
      'matcher-name': 'unauthenticated-ping',
      'matched-at': 'tcp://[2001:db8::10]:6379',
    })
    const noAuth = JSON.stringify({
      'template-id': REDIS_PING_TEMPLATE_ID,
      'matcher-name': 'authentication-required',
      'matched-at': '2001:db8::10:6379',
    })
    expect(parseRedisNucleiOutput(pong, '[2001:db8::10]:6379')).toEqual({
      completed: true,
      matched: true,
    })
    expect(parseRedisNucleiOutput(noAuth, '[2001:db8::10]:6379')).toEqual({
      completed: true,
      matched: false,
    })
    expect(parseRedisNucleiOutput('', '[2001:db8::10]:6379').completed).toBe(false)
    expect(parseRedisNucleiOutput(`${pong}\nnot-json`, '[2001:db8::10]:6379').completed).toBe(false)
    expect(parseRedisNucleiOutput(pong, '[2001:db8::11]:6379').completed).toBe(false)
  })

  it('spawns with isolated environment and private pre-created output', async () => {
    spawnMock.mockImplementationOnce((_command, args: string[], options) => {
      const output = args[args.indexOf('-o') + 1]!
      expect(statSync(output).mode & 0o777).toBe(0o600)
      expect(options.env).not.toHaveProperty('SAKUDA_ENCRYPTION_KEY')
      expect(options.env.HOME).toContain(options.cwd)
      expect(options.env.DISABLE_NUCLEI_TEMPLATES_PUBLIC_DOWNLOAD).toBe('true')
      writeFileSync(
        output,
        JSON.stringify({
          'template-id': REDIS_PING_TEMPLATE_ID,
          'matcher-name': 'authentication-required',
          'matched-at': '192.0.2.1:6379',
        }),
      )
      const child = Object.assign(new EventEmitter(), { pid: 4242 })
      setTimeout(() => child.emit('close', 0), 0)
      return child
    })
    await expect(
      runRedisPingTemplate({
        address: '192.0.2.1',
        port: 6379,
        timeoutMs: 3000,
        signal: new AbortController().signal,
        nucleiBin: 'nuclei-test',
      }),
    ).resolves.toEqual({ completed: true, matched: false })
  })

  it('does not spawn for a pre-aborted request', async () => {
    spawnMock.mockClear()
    const controller = new AbortController()
    controller.abort()
    await expect(
      runRedisPingTemplate({
        address: '192.0.2.1',
        port: 6379,
        timeoutMs: 3000,
        signal: controller.signal,
        nucleiBin: 'nuclei-test',
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('waits for child close before resolving an aborted run', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 4343 })
    spawnMock.mockImplementationOnce(() => child)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const controller = new AbortController()
    let settled = false
    const result = runRedisPingTemplate({
      address: '192.0.2.1',
      port: 6379,
      timeoutMs: 3000,
      signal: controller.signal,
      nucleiBin: 'nuclei-test',
    })
    void result
      .finally(() => {
        settled = true
      })
      .catch(() => {})
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(kill).toHaveBeenCalledWith(-4343, 'SIGTERM')
    child.emit('close', null, 'SIGTERM')
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(settled).toBe(true)
    kill.mockRestore()
  })
})
