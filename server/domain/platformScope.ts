import { createHash } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type { PlatformInput } from '#shared/schemas/platform'
import type { PlatformScope } from '#shared/types/platform'
import { ServiceError } from '../services/errors'

const MAX_HOSTS = 256
function invalid(message: string): never {
  throw new ServiceError(422, 'PLATFORM_SCOPE', message)
}
export function normalizePlatformHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, '')
  if (isIP(host)) return isIP(host) === 6 ? new URL(`http://[${host}]`).hostname.slice(1, -1) : host
  if (host.length > 253 || (!host.includes('.') && host !== 'localhost'))
    invalid('Use an IP or fully qualified hostname')
  if (!host.split('.').every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)))
    invalid('Invalid host; URLs, wildcards and port suffixes are not accepted')
  return host
}
function ipv4Number(host: string): number {
  return host.split('.').reduce((n, p) => n * 256 + Number(p), 0)
}
function cidr(value: string): { base: number; size: number } {
  const [ip, prefix, extra] = value.split('/')
  if (!ip || isIP(ip) !== 4 || !prefix || !/^\d{1,2}$/.test(prefix) || extra !== undefined)
    invalid('Only IPv4 CIDR is supported; use explicit IPv6 addresses')
  const bits = Number(prefix)
  if (bits > 32) invalid('Invalid CIDR prefix')
  const size = 2 ** (32 - bits)
  return { base: Math.floor(ipv4Number(ip) / size) * size, size }
}
function entries(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]+/)
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
}
export function platformExcluded(host: string, exclusions: string): boolean {
  const normalized = normalizePlatformHost(host)
  return entries(exclusions).some((entry) => {
    if (!entry.includes('/')) return normalizePlatformHost(entry) === normalized
    const range = cidr(entry)
    return (
      isIP(normalized) === 4 &&
      ipv4Number(normalized) >= range.base &&
      ipv4Number(normalized) < range.base + range.size
    )
  })
}
export function previewPlatformScope(
  input: PlatformInput,
): Omit<PlatformScope, 'assets' | 'preparedAt' | 'scopeToken'> {
  // Validate all exclusions even when the target list contains no matching address.
  for (const entry of entries(input.exclusions)) {
    if (entry.includes('/')) cidr(entry)
    else normalizePlatformHost(entry)
  }
  const hosts = new Set<string>()
  const automaticExcluded = new Set<string>()
  for (const entry of entries(input.targets)) {
    if (entry.includes('/')) {
      const range = cidr(entry)
      if (range.size > MAX_HOSTS) invalid('CIDR exceeds 256 addresses; narrow the scope')
      for (let n = range.base; n < range.base + range.size; n++) {
        const host = [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.')
        hosts.add(host)
        if (range.size >= 4 && (n === range.base || n === range.base + range.size - 1))
          automaticExcluded.add(host)
      }
    } else hosts.add(normalizePlatformHost(entry))
    if (hosts.size > MAX_HOSTS) invalid('Maximum 256 hosts per group')
  }
  const excluded = [...hosts].filter(
    (h) => automaticExcluded.has(h) || platformExcluded(h, input.exclusions),
  )
  const included = [...hosts].filter((h) => !excluded.includes(h)).sort()
  if (!included.length) invalid('No included targets remain')
  const endpointCount = included.length * new Set(input.ports).size
  if (endpointCount > 256) invalid('Maximum 256 host/port pairs; narrow the scope')
  const requestBudget =
    endpointCount +
    included.length * new Set(input.tlsPorts).size +
    included.length * new Set(input.redisPorts).size
  const estimatedSeconds = Math.ceil(
    requestBudget * (1 / input.connectionsPerSecond + input.timeoutSeconds + 1),
  )
  if (estimatedSeconds > input.maxMinutes * 60)
    invalid('Work estimate exceeds time limit; reduce targets/ports or increase time limit')
  return {
    estimatedSeconds,
    requestBudget,
    hosts: included,
    excluded,
    hostCount: included.length,
    endpointCount: included.length * new Set(input.ports).size,
  }
}

export function assertPlatformAddress(
  address: string,
  location: PlatformInput['location'],
  pointToPoint = false,
): void {
  const family = isIP(address)
  if (!family) invalid('DNS did not resolve to an IP address')
  const type = family === 4 ? 'ipv4' : 'ipv6'
  const blocked = new BlockList()
  for (const [host, prefix] of [
    ['0.0.0.0', 8],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    blocked.addSubnet(host, prefix)
  for (const [host, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['ff00::', 8],
    ['fe80::', 10],
  ] as const)
    blocked.addSubnet(host, prefix, 'ipv6')
  if (family === 6) blocked.addSubnet('::ffff:0:0', 96, 'ipv6')
  if (blocked.check(address, type))
    invalid(
      'Unspecified, loopback, link-local, mapped, multicast or broadcast destinations are forbidden',
    )
  if (family === 4 && address.endsWith('.255') && !pointToPoint)
    invalid('Potential broadcast destinations are forbidden')
  if (location === 'external') {
    const privateRanges = new BlockList()
    for (const [host, prefix] of [
      ['10.0.0.0', 8],
      ['172.16.0.0', 12],
      ['192.168.0.0', 16],
      ['100.64.0.0', 10],
      ['198.18.0.0', 15],
      ['192.0.0.0', 24],
    ] as const)
      privateRanges.addSubnet(host, prefix)
    privateRanges.addSubnet('fc00::', 7, 'ipv6')
    if (privateRanges.check(address, type))
      invalid('External execution requires public IP addresses')
    if (family === 6) {
      const global = new BlockList()
      global.addSubnet('2000::', 3, 'ipv6')
      if (!global.check(address, 'ipv6'))
        invalid('External execution requires global IPv6 addresses')
    }
  }
}
export type PlatformResolver = (host: string) => Promise<{ address: string }[]>
export async function resolvePlatformScope(
  input: PlatformInput,
  now: () => Date,
  resolver: PlatformResolver = (host) => lookup(host, { all: true }),
): Promise<PlatformScope> {
  const scope = previewPlatformScope(input)
  const assets: PlatformScope['assets'] = []
  // Four DNS queries at most in flight, with a 10-second total preview budget.
  // No diagnostic TCP/TLS connections occur here; all resolved addresses are confirmed later.
  let cursor = 0
  let stopped = false
  const expiresAt = Date.now() + 10000
  async function resolveHost(host: string): Promise<void> {
    let addresses: string[]
    if (isIP(host)) addresses = [host]
    else {
      if (stopped || Date.now() >= expiresAt)
        invalid('DNS preview time budget exceeded; use explicit IPs')
      let timer: NodeJS.Timeout | undefined
      try {
        const resolved = await Promise.race([
          resolver(host),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('DNS timeout')),
              Math.min(3000, expiresAt - Date.now()),
            )
          }),
        ])
        addresses = [...new Set(resolved.map((r) => normalizePlatformHost(r.address)))].sort()
      } catch {
        invalid('DNS preview failed; use an explicit IP address')
      } finally {
        clearTimeout(timer)
      }
    }
    if (addresses.length !== 1)
      invalid(
        'Hostname must resolve to exactly one IP; register explicitly selected IPs for multi-address hosts',
      )
    const address = addresses[0]!
    if (platformExcluded(address, input.exclusions)) {
      scope.excluded.push(host)
      return
    }
    assertPlatformAddress(address, input.location, pointToPointAddress(input.targets, address))
    assets.push({ host, address })
  }
  async function worker(): Promise<void> {
    while (!stopped) {
      const host = scope.hosts[cursor++]
      if (!host) return
      try {
        await resolveHost(host)
      } catch (error) {
        stopped = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, scope.hosts.length) }, worker))
  assets.sort((a, b) => a.host.localeCompare(b.host))
  scope.excluded.sort()
  if (!assets.length) invalid('No included resolved destinations remain')
  const preparedAt = now().toISOString()
  const hosts = assets.map((a) => a.host)
  const requestBudget = (assets.length / scope.hostCount) * scope.requestBudget
  return {
    ...scope,
    hosts,
    assets,
    preparedAt,
    hostCount: assets.length,
    endpointCount: assets.length * new Set(input.ports).size,
    requestBudget,
    estimatedSeconds: Math.ceil((assets.length / scope.hostCount) * scope.estimatedSeconds),
    scopeToken: createHash('sha256')
      .update(JSON.stringify({ input, assets, preparedAt }))
      .digest('hex'),
  }
}

function pointToPointAddress(targets: string, address: string): boolean {
  if (isIP(address) !== 4) return false
  return entries(targets).some((entry) => {
    if (!entry.includes('/')) return false
    const range = cidr(entry)
    return (
      range.size <= 2 &&
      ipv4Number(address) >= range.base &&
      ipv4Number(address) < range.base + range.size
    )
  })
}
