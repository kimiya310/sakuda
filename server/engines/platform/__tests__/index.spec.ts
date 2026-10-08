import { describe, expect, it, vi } from 'vitest'
import type { PlatformRun } from '#shared/types/platform'
import { runPlatformChecks } from '..'

function run(overrides: Partial<PlatformRun['snapshot']> = {}): PlatformRun {
  return {
    id: 'run-1',
    groupId: 'group-1',
    status: 'running',
    snapshot: {
      profile: 'sales-tcp-v1',
      customer: 'Example',
      name: 'Approved target',
      targets: 'server.example.test',
      exclusions: '',
      ports: [22, 443, 6379],
      tlsPorts: [443],
      redisPorts: [6379],
      location: 'lan',
      concurrency: 2,
      connectionsPerSecond: 5,
      timeoutSeconds: 3,
      maxMinutes: 5,
      ...overrides,
    },
    scope: {
      assets: [{ host: 'server.example.test', address: '192.0.2.10' }],
      preparedAt: '2026-01-01T00:00:00.000Z',
      estimatedSeconds: 3,
      requestBudget: 5,
      hosts: ['server.example.test'],
      excluded: [],
      hostCount: 1,
      endpointCount: 3,
      scopeToken: 'a'.repeat(64),
    },
    authorization: {
      expectedHostCount: 1,
      scopeToken: 'a'.repeat(64),
      administrator: 'Owner',
      authorizationReference: 'ticket-1',
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-01T01:00:00.000Z',
      permissionConfirmed: true,
      segmentsConfirmed: true,
    },
    result: { endpoints: [], findings: [], warnings: [] },
    review: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    error: null,
  }
}

const immediateRate = {
  now: () => 0,
  sleep: async (_milliseconds: number, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  },
}

describe('runPlatformChecks', () => {
  it('uses only pinned addresses and classifies bounded checks without preserving raw banners', async () => {
    const tcpProbe = vi.fn(async ({ address, port }: { address: string; port: number }) => ({
      status: 'open' as const,
      banner: port === 22 ? Buffer.from('SSH-2.0-OpenSSH_9.5p1 private-hostname\r\n') : undefined,
      address,
    }))
    const tlsProbe = vi.fn(async () => ({
      protocol: 'TLSv1.2',
      cipher: 'ECDHE-RSA-AES128-GCM-SHA256',
      subject: 'CN=other.example.test',
      issuer: 'CN=Test CA',
      validTo: '2025-01-01T00:00:00.000Z',
      authorized: false,
      expired: true,
      notYetValid: false,
      hostnameMismatch: true,
    }))
    const networkTemplate = vi.fn(async () => ({ completed: true, matched: true }))

    const result = await runPlatformChecks(run(), new AbortController().signal, {
      tcpProbe,
      tlsProbe,
      networkTemplate,
      ...immediateRate,
    })

    expect(tcpProbe).toHaveBeenCalledTimes(3)
    expect(tcpProbe.mock.calls.every(([input]) => input.address === '192.0.2.10')).toBe(true)
    expect(tlsProbe).toHaveBeenCalledWith(
      expect.objectContaining({ address: '192.0.2.10', host: 'server.example.test', port: 443 }),
    )
    expect(networkTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ address: '192.0.2.10', port: 6379, nucleiBin: 'nuclei' }),
    )
    expect(result.findings.map((item) => [item.ruleId, item.classification])).toEqual(
      expect.arrayContaining([
        ['CVE-2023-48795', 'inferred'],
        ['tls-certificate-expired', 'confirmed'],
        ['tls-hostname-mismatch', 'confirmed'],
        ['tls-certificate-untrusted', 'needs-review'],
        ['redis-unauthenticated-ping', 'needs-review'],
      ]),
    )
    const ssh = result.endpoints.find((item) => item.port === 22)!
    expect(ssh).toMatchObject({
      service: 'ssh',
      product: 'OpenSSH',
      version: '9.5p1',
      coverage: {
        tcp: 'done',
        version: 'done',
        tls: 'not-applicable',
        networkTemplate: 'not-applicable',
      },
    })
    expect(JSON.stringify(result)).not.toContain('private-hostname')
  })

  it('does not turn an unavailable approved template into a clean result', async () => {
    const result = await runPlatformChecks(
      run({ ports: [6379], tlsPorts: [], concurrency: 1 }),
      new AbortController().signal,
      {
        tcpProbe: async () => ({ status: 'open' }),
        networkTemplate: async () => ({ completed: false, matched: false }),
        ...immediateRate,
      },
    )
    expect(result.findings).toEqual([])
    expect(result.endpoints[0]?.coverage.networkTemplate).toBe('failed')
    expect(result.endpoints[0]?.notes.join(' ')).toContain('remains unverified')
  })

  it('distinguishes refused and unreachable endpoints and never runs later phases', async () => {
    const networkTemplate = vi.fn()
    const tlsProbe = vi.fn()
    const result = await runPlatformChecks(
      run({ ports: [443, 6379], tlsPorts: [443] }),
      new AbortController().signal,
      {
        tcpProbe: async ({ port }) => ({ status: port === 443 ? 'closed' : 'unreachable' }),
        tlsProbe,
        networkTemplate,
        ...immediateRate,
      },
    )
    expect(result.endpoints.map((endpoint) => endpoint.status)).toEqual(['closed', 'unreachable'])
    expect(
      result.endpoints.every((endpoint) => endpoint.coverage.networkTemplate === 'not-applicable'),
    ).toBe(true)
    expect(tlsProbe).not.toHaveBeenCalled()
    expect(networkTemplate).not.toHaveBeenCalled()
  })

  it('performs no work after an already-aborted signal and records every endpoint', async () => {
    const controller = new AbortController()
    controller.abort()
    const tcpProbe = vi.fn()
    const result = await runPlatformChecks(run(), controller.signal, { tcpProbe, ...immediateRate })
    expect(tcpProbe).not.toHaveBeenCalled()
    expect(result.endpoints).toHaveLength(3)
    expect(result.endpoints.every((endpoint) => endpoint.status === 'not-run')).toBe(true)
    expect(
      result.endpoints.every((endpoint) =>
        Object.values(endpoint.coverage).every((value) => value === 'cancelled'),
      ),
    ).toBe(true)
  })

  it('marks a port-only service identification as requiring review', async () => {
    const result = await runPlatformChecks(
      run({ ports: [22], tlsPorts: [], concurrency: 1 }),
      new AbortController().signal,
      {
        tcpProbe: async () => ({ status: 'open' }),
        ...immediateRate,
      },
    )
    expect(result.endpoints[0]).toMatchObject({ service: 'ssh', product: null, version: null })
    expect(result.endpoints[0]?.notes.join(' ')).toContain('inferred from the selected port')
    expect(result.endpoints[0]?.coverage.version).toBe('not-applicable')
    expect(result.findings).toEqual([])
  })

  it('enforces the configured concurrency limit across endpoint work', async () => {
    let active = 0
    let maximum = 0
    const result = await runPlatformChecks(
      run({ ports: [20, 21, 22, 23], tlsPorts: [], concurrency: 2 }),
      new AbortController().signal,
      {
        tcpProbe: async () => {
          active++
          maximum = Math.max(maximum, active)
          await new Promise((resolve) => setTimeout(resolve, 2))
          active--
          return { status: 'closed' }
        },
        ...immediateRate,
      },
    )
    expect(result.endpoints).toHaveLength(4)
    expect(maximum).toBe(2)
  })

  it('bounds a dependency that ignores its phase signal', async () => {
    const result = await runPlatformChecks(
      run({ ports: [22], tlsPorts: [], concurrency: 1, timeoutSeconds: 0.001 }),
      new AbortController().signal,
      { tcpProbe: async () => await new Promise(() => {}), ...immediateRate },
    )
    expect(result.endpoints[0]).toMatchObject({
      status: 'unreachable',
      coverage: { tcp: 'failed' },
    })
  })

  it('stops queued and active work when execution is aborted', async () => {
    const controller = new AbortController()
    const tcpProbe = vi.fn(
      async ({ signal }: { signal: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          )
          controller.abort()
        }),
    )
    const result = await runPlatformChecks(run(), controller.signal, {
      tcpProbe,
      ...immediateRate,
    })
    expect(tcpProbe).toHaveBeenCalledTimes(1)
    expect(result.endpoints.every((endpoint) => endpoint.status === 'not-run')).toBe(true)
    expect(
      result.endpoints.every((endpoint) =>
        Object.values(endpoint.coverage).every((value) => value === 'cancelled'),
      ),
    ).toBe(true)
  })
})

describe('explicit protocol approval', () => {
  it('never sends PING solely due to TCP6379 or a generic negative banner', async () => {
    const networkTemplate = vi.fn()
    const result = await runPlatformChecks(
      run({ ports: [6379], tlsPorts: [], redisPorts: [] }),
      new AbortController().signal,
      {
        tcpProbe: async () => ({
          status: 'open',
          banner: Buffer.from('-ERR generic line protocol'),
        }),
        networkTemplate,
        ...immediateRate,
      },
    )
    expect(networkTemplate).not.toHaveBeenCalled()
    expect(result.endpoints[0]?.product).toBeNull()
    expect(result.endpoints[0]?.coverage.networkTemplate).toBe('not-applicable')
  })
  it('runs the fixed template only on separately approved nonstandard Redis ports', async () => {
    const networkTemplate = vi.fn(async () => ({ completed: true, matched: false }))
    await runPlatformChecks(
      run({ ports: [6380], tlsPorts: [], redisPorts: [6380] }),
      new AbortController().signal,
      { tcpProbe: async () => ({ status: 'open' }), networkTemplate, ...immediateRate },
    )
    expect(networkTemplate).toHaveBeenCalledWith(expect.objectContaining({ port: 6380 }))
  })
})
