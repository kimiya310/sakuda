import { describe, expect, it, vi } from 'vitest'
import { PlatformInputSchema, PlatformStartSchema } from '#shared/schemas/platform'
import {
  assertPlatformAddress,
  normalizePlatformHost,
  platformExcluded,
  previewPlatformScope,
  resolvePlatformScope,
} from '../platformScope'

// No system DNS in tests: accidental lookup fails rather than reaching the network.
vi.mock('node:dns/promises', () => ({
  lookup: () => {
    throw new Error('Real DNS forbidden in platform tests')
  },
}))
const input = (patch: Record<string, unknown> = {}) =>
  PlatformInputSchema.parse({
    customer: 'Fixture',
    name: 'Approved subnet',
    targets: '10.0.0.0/30',
    exclusions: '10.0.0.0',
    ports: [22, 443],
    tlsPorts: [443],
    location: 'lan',
    ...patch,
  })
const now = () => new Date('2026-01-01T00:00:00Z')

describe('platform scope safety (no network)', () => {
  it('expands and deduplicates explicit CIDR before count confirmation and exclusions', async () => {
    const result = await resolvePlatformScope(input({ targets: '10.0.0.0/30\n10.0.0.1' }), now)
    expect(result.hosts).toEqual(['10.0.0.1', '10.0.0.2'])
    expect(result.excluded).toEqual(['10.0.0.0', '10.0.0.3'])
    expect(result.endpointCount).toBe(4)
    expect(result.scopeToken).toHaveLength(64)
    expect(result.assets[0]).toEqual({ host: '10.0.0.1', address: '10.0.0.1' })
  })
  it('rejects broad CIDR, invalid destinations, arbitrary ports and URLs', () => {
    for (const targets of [
      '10.0.0.0/16',
      '10.0.0.1/33',
      'https://example.test',
      '-Pn',
      'example.test:22',
      '2001:db8::/64',
    ])
      expect(() => previewPlatformScope(input({ targets }))).toThrow()
    expect(() => PlatformInputSchema.parse({ ...input(), ports: [0] })).toThrow()
    expect(() => input({ tlsPorts: [8443] })).toThrow()
    expect(() => previewPlatformScope(input({ exclusions: 'bad/path' }))).toThrow()
  })
  it('caps endpoint work and rejects scopes too large for the selected time budget', () => {
    expect(() =>
      previewPlatformScope(input({ targets: '10.0.0.0/24', exclusions: '', maxMinutes: 30 })),
    ).toThrow('256 host/port')
    expect(() =>
      previewPlatformScope(input({ targets: '10.0.0.0/26', exclusions: '', maxMinutes: 1 })),
    ).toThrow('Work estimate')
  })
  it('pins one mocked DNS address before approval and applies IP exclusions', async () => {
    const resolver = vi.fn(async () => [{ address: '10.0.0.10' }])
    const scope = await resolvePlatformScope(input({ targets: 'APP.EXAMPLE.TEST.' }), now, resolver)
    expect(scope.assets).toEqual([{ host: 'app.example.test', address: '10.0.0.10' }])
    expect(resolver).toHaveBeenCalledOnce()
    await expect(
      resolvePlatformScope(
        input({ targets: 'app.example.test', exclusions: '10.0.0.0/24' }),
        now,
        resolver,
      ),
    ).rejects.toThrow('No included resolved')
    await expect(
      resolvePlatformScope(input({ targets: 'app.example.test' }), now, async () => [
        { address: '10.0.0.1' },
        { address: '10.0.0.2' },
      ]),
    ).rejects.toThrow('exactly one')
  })
  it('supports IPv6 literal normalization/exclusion without DNS', async () => {
    const resolver = vi.fn()
    const scope = await resolvePlatformScope(
      input({ targets: 'fd00:0:0::1', exclusions: '', ports: [22], tlsPorts: [] }),
      now,
      resolver,
    )
    expect(scope.assets[0]?.address).toBe('fd00::1')
    expect(platformExcluded('fd00::1', 'fd00:0:0:0:0:0:0:1')).toBe(true)
    expect(resolver).not.toHaveBeenCalled()
    expect(normalizePlatformHost('::1')).toBe('::1')
  })
  it('forbids unsafe address classes and private external addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '0.0.0.0',
      '169.254.1.2',
      '224.0.0.1',
      '255.255.255.255',
      '10.0.0.255',
      '::',
      '::1',
      'ff02::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ])
      expect(() => assertPlatformAddress(ip, 'lan')).toThrow()
    for (const ip of ['10.1.1.1', '172.16.0.1', '192.168.0.1', '100.64.0.1', 'fd00::1'])
      expect(() => assertPlatformAddress(ip, 'external')).toThrow()
    expect(() => assertPlatformAddress('10.1.1.1', 'vpn')).not.toThrow()
  })
  it('refuses a reversed authorization window', () => {
    expect(() =>
      PlatformStartSchema.parse({
        expectedHostCount: 1,
        scopeToken: 'a'.repeat(64),
        administrator: 'Owner',
        authorizationReference: 'Approval fixture',
        windowStart: '2026-01-01T01:00:00Z',
        windowEnd: '2026-01-01T00:00:00Z',
        permissionConfirmed: true,
        segmentsConfirmed: true,
      }),
    ).toThrow()
  })
})

describe('CIDR subnet boundary and explicit protocol approval', () => {
  it('excludes network/broadcast for /25 and /30 but keeps /31-/32 point-to-point targets', async () => {
    const common = { exclusions: '', ports: [22], tlsPorts: [], maxMinutes: 30 }
    const subnet = await resolvePlatformScope(input({ ...common, targets: '10.0.0.0/25' }), now)
    expect(subnet.hostCount).toBe(126)
    expect(subnet.excluded).toEqual(['10.0.0.0', '10.0.0.127'])
    const pair = await resolvePlatformScope(input({ ...common, targets: '10.0.0.254/31' }), now)
    expect(pair.hosts).toEqual(['10.0.0.254', '10.0.0.255'])
    const single = await resolvePlatformScope(input({ ...common, targets: '10.0.0.255/32' }), now)
    expect(single.hostCount).toBe(1)
  })
  it('counts approved nonstandard Redis ports and refuses ports outside TCP scope', () => {
    const base = input({ targets: '10.0.0.1', exclusions: '', ports: [6380], tlsPorts: [] })
    expect(previewPlatformScope(base).requestBudget).toBe(1)
    expect(previewPlatformScope({ ...base, redisPorts: [6380] }).requestBudget).toBe(2)
    expect(() => input({ redisPorts: [6380] })).toThrow()
  })
})
