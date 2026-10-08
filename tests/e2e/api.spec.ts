import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import { afterAll, describe, expect, it } from 'vitest'

// Must be set before `setup()` boots the server subprocess: it inherits
// process.env, and the app validates these at startup (server/config/env.ts).
process.env.SAKUDA_ENCRYPTION_KEY = randomBytes(32).toString('base64')
const dataDir = await mkdtemp(join(tmpdir(), 'sakuda-e2e-'))
process.env.SAKUDA_DATA_DIR = dataDir
// Keep the queue from ever running a real scan — these tests only assert on
// API-level state transitions (queued/409/etc.), not engine execution.
process.env.SAKUDA_JOB_RUNNER = 'off'

await setup({ server: true })

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function requireId(v: unknown): string {
  if (!isRecord(v) || typeof v.id !== 'string')
    throw new Error(`expected an object with id, got ${JSON.stringify(v)}`)
  return v.id
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('api e2e', () => {
  const cookieValue = 'super-secret-cookie-value-123456'
  let siteId: string
  let scanId: string

  it('POST /api/sites creates a site and never echoes header values', async () => {
    const res = await postJson('/api/sites', {
      name: 'Local target',
      frontBaseUrl: 'http://localhost:39991',
      nucleiPaths: '/',
      headers: [{ name: 'Cookie', value: cookieValue }],
    })
    expect(res.status).toBe(201)
    const site: unknown = await res.json()
    expect(site).toMatchObject({ headerNames: ['Cookie'] })
    expect(JSON.stringify(site)).not.toContain(cookieValue)
    siteId = requireId(site)
  })

  it('GET /api/sites lists the created site with no scan yet', async () => {
    const res = await fetch('/api/sites')
    expect(res.status).toBe(200)
    const sites: unknown = await res.json()
    expect(Array.isArray(sites)).toBe(true)
    expect(sites).toHaveLength(1)
    expect(sites).toMatchObject([{ id: siteId, lastScan: null }])
  })

  it('POST /api/sites/:id/scans queues a nuclei-only scan', async () => {
    const res = await postJson(`/api/sites/${siteId}/scans`, { engines: ['nuclei'] })
    expect(res.status).toBe(202)
    const scan: unknown = await res.json()
    expect(scan).toMatchObject({ status: 'queued' })
    scanId = requireId(scan)
  })

  it('a second POST while one is active is rejected', async () => {
    const res = await postJson(`/api/sites/${siteId}/scans`, { engines: ['nuclei'] })
    expect(res.status).toBe(409)
  })

  it('GET /api/scans/:id reports queued status', async () => {
    const res = await fetch(`/api/scans/${scanId}`)
    expect(res.status).toBe(200)
    const scan: unknown = await res.json()
    expect(scan).toMatchObject({ status: 'queued' })
  })

  it('GET /api/jobs lists the queued scan with its kind, site, and engines', async () => {
    const res = await fetch('/api/jobs')
    expect(res.status).toBe(200)
    const list: unknown = await res.json()
    expect(list).toMatchObject([
      {
        kind: 'scan',
        status: 'queued',
        id: scanId,
        siteId,
        siteName: 'Local target',
        engines: ['nuclei'],
      },
    ])
  })

  it('GET /api/scans/:id/report.md is rejected before the scan finishes', async () => {
    const res = await fetch(`/api/scans/${scanId}/report.md`)
    expect(res.status).toBe(409)
  })

  it('POST /api/sites/:id/discoveries is rejected while a scan is active', async () => {
    const res = await postJson(`/api/sites/${siteId}/discoveries`, {})
    expect(res.status).toBe(409)
  })

  it('POST /api/sites/:id/targets appends new target lines, skipping ones already saved', async () => {
    const res = await postJson(`/api/sites/${siteId}/targets`, {
      lines: ['/', '/rest/products/search?q=', '/login'],
    })
    expect(res.status).toBe(200)
    const body: unknown = await res.json()
    expect(body).toMatchObject({
      added: ['/rest/products/search?q=', '/login'],
      skipped: ['/'],
      site: { id: siteId, nucleiPaths: '/\n/rest/products/search?q=\n/login\n' },
    })

    const site = await fetch(`/api/sites/${siteId}`)
    expect(await site.json()).toMatchObject({
      nucleiPaths: '/\n/rest/products/search?q=\n/login\n',
    })
  })

  it('POST /api/sites/:id/targets rejects invalid lines with 422 and changes nothing', async () => {
    const res = await postJson(`/api/sites/${siteId}/targets`, {
      lines: ['/ok', 'http://absolute.example/x'],
    })
    expect(res.status).toBe(422)
    const site = await fetch(`/api/sites/${siteId}`)
    expect(await site.json()).toMatchObject({
      nucleiPaths: '/\n/rest/products/search?q=\n/login\n',
    })
  })

  it('DELETE /api/sites/:id/targets removes one saved line, idempotently', async () => {
    const del = (line: string) =>
      fetch(`/api/sites/${siteId}/targets`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ line }),
      })
    const res = await del('/login')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      removed: true,
      site: { id: siteId, nucleiPaths: '/\n/rest/products/search?q=\n' },
    })
    const again = await del('/login')
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ removed: false })
    const site = await fetch(`/api/sites/${siteId}`)
    expect(await site.json()).toMatchObject({ nucleiPaths: '/\n/rest/products/search?q=\n' })
  })

  it('GET /api/sites/:id/targets summarizes the saved list per engine, paths only', async () => {
    const res = await fetch(`/api/sites/${siteId}/targets`)
    expect(res.status).toBe(200)
    const body: unknown = await res.json()
    expect(body).toMatchObject({
      configured: true,
      activeChecks: false,
      common: [
        { method: 'GET', base: 'front', path: '/' },
        { method: 'GET', base: 'front', path: '/rest/products/search?q=' },
      ],
      engines: { nuclei: { available: true }, dalfox: { available: false, targets: [] } },
      zapApiSource: 'none',
    })
    expect(JSON.stringify(body)).not.toContain('localhost')
    const missing = await fetch('/api/sites/nope/targets')
    expect(missing.status).toBe(404)
  })

  it('GET /api/sites/:id/discoveries lists nothing for a site that never discovered', async () => {
    const res = await fetch(`/api/sites/${siteId}/discoveries`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('discovery flow on a fresh site: POST queues, GET detail reports queued, second POST is 409', async () => {
    const created = await postJson('/api/sites', {
      name: 'Discovery target',
      frontBaseUrl: 'http://localhost:39993',
    })
    expect(created.status).toBe(201)
    const otherSiteId = requireId(await created.json())

    const res = await postJson(`/api/sites/${otherSiteId}/discoveries`, {})
    expect(res.status).toBe(202)
    const discovery: unknown = await res.json()
    expect(discovery).toMatchObject({ siteId: otherSiteId, status: 'queued', urlCount: 0 })
    const discoveryId = requireId(discovery)

    const detail = await fetch(`/api/discoveries/${discoveryId}`)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({ id: discoveryId, status: 'queued', urls: [] })

    const list = await fetch(`/api/sites/${otherSiteId}/discoveries`)
    expect(await list.json()).toMatchObject([{ id: discoveryId }])

    expect((await postJson(`/api/sites/${otherSiteId}/discoveries`, {})).status).toBe(409)
    // and a scan must wait for the discovery too
    expect(
      (await postJson(`/api/sites/${otherSiteId}/scans`, { engines: ['nuclei'] })).status,
    ).toBe(409)
  })

  it('browserStorage is write-only: names come back, values never do; bad seed lines are 422', async () => {
    const secret = 'eyJ-super-secret-token-value'
    const res = await postJson('/api/sites', {
      name: 'SPA target',
      frontBaseUrl: 'http://localhost:39994',
      discoverySeedPaths: '/#/\n/#/basket',
      browserStorage: [
        { kind: 'localStorage', name: 'token', value: secret },
        { kind: 'sessionStorage', name: 'bid', value: '6' },
      ],
    })
    expect(res.status).toBe(201)
    const site: unknown = await res.json()
    expect(site).toMatchObject({
      discoverySeedPaths: '/#/\n/#/basket',
      browserStorageNames: [
        { kind: 'localStorage', name: 'token' },
        { kind: 'sessionStorage', name: 'bid' },
      ],
    })
    expect(JSON.stringify(site)).not.toContain(secret)
    const again = await fetch(`/api/sites/${requireId(site)}`)
    expect(JSON.stringify(await again.json())).not.toContain(secret)

    const bad = await postJson('/api/sites', {
      name: 'Bad seeds',
      frontBaseUrl: 'http://localhost:39995',
      discoverySeedPaths: 'http://absolute.example/',
    })
    expect(bad.status).toBe(422)
    expect(JSON.stringify(await bad.json())).toContain('discoverySeedPaths')
  })

  it('POST /api/sites with a non-JSON content-type is rejected with 415 (I7)', async () => {
    const res = await fetch('/api/sites', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({
        name: 'Cross-origin form',
        frontBaseUrl: 'http://localhost:39992',
        nucleiPaths: '/',
      }),
    })
    expect(res.status).toBe(415)
  })

  it('a non-local site without nonLocalConfirmed is rejected with a nonLocalConfirmed issue', async () => {
    const res = await postJson('/api/sites', {
      name: 'Remote target',
      frontBaseUrl: 'https://example.com',
      nucleiPaths: '/',
    })
    expect(res.status).toBe(422)
    const body: unknown = await res.json()
    expect(JSON.stringify(body)).toContain('nonLocalConfirmed')
  })
})

// Platform API tests only: the job runner is disabled above and targets are
// literal fixture IPs, so neither DNS nor diagnostic sockets are used.
describe('platform API e2e (no diagnostic execution)', () => {
  let groupId: string
  let runId: string
  let scopeToken: string
  it('rejects unsafe targets and creates a pinned LAN manifest without starting a scan', async () => {
    const config = {
      customer: 'Synthetic customer',
      name: 'Synthetic platform',
      targets: '10.254.254.1',
      exclusions: '',
      ports: [22],
      tlsPorts: [],
      location: 'lan',
    }
    const unsafe = await postJson('/api/platform/groups', { ...config, targets: '127.0.0.1' })
    expect(unsafe.status).toBe(422)
    const res = await postJson('/api/platform/groups', config)
    expect(res.status).toBe(201)
    const group: unknown = await res.json()
    groupId = requireId(group)
    expect(group).toMatchObject({
      config: { customer: 'Synthetic customer' },
      scope: { assets: [{ host: '10.254.254.1', address: '10.254.254.1' }], hostCount: 1 },
    })
    if (!isRecord(group) || !isRecord(group.scope) || typeof group.scope.scopeToken !== 'string')
      throw new Error('Missing scope token')
    scopeToken = group.scope.scopeToken
    const list = await fetch(`/api/platform/groups/${groupId}`)
    expect(await list.json()).toMatchObject({ runs: [] })
  })
  it('marks API and SSR platform responses as private and non-cacheable', async () => {
    for (const path of ['/api/platform/groups', '/platform', `/platform/groups/${groupId}`]) {
      const res = await fetch(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('private')
      expect(res.headers.get('cache-control')).toContain('no-store')
    }
  })
  it('requires written consent and exact scope count before queueing', async () => {
    const consent = {
      expectedHostCount: 1,
      scopeToken,
      administrator: 'Fixture owner',
      authorizationReference: 'Synthetic written approval',
      windowStart: new Date(Date.now() - 60000).toISOString(),
      windowEnd: new Date(Date.now() + 60000).toISOString(),
      permissionConfirmed: true,
      segmentsConfirmed: true,
    }
    const denied = await postJson(`/api/platform/groups/${groupId}/runs`, {
      ...consent,
      permissionConfirmed: false,
    })
    expect(denied.status).toBe(422)
    const res = await postJson(`/api/platform/groups/${groupId}/runs`, consent)
    expect(res.status).toBe(201)
    const run: unknown = await res.json()
    runId = requireId(run)
    expect(run).toMatchObject({
      status: 'queued',
      result: { endpoints: [expect.objectContaining({ status: 'not-run' })] },
    })
  })
  it('blocks unreviewed report and active deletion, then cancels without diagnostic traffic', async () => {
    expect((await fetch(`/api/platform/runs/${runId}/report.md`)).status).toBe(409)
    expect((await fetch(`/api/platform/groups/${groupId}`, { method: 'DELETE' })).status).toBe(409)
    const cancelled = await postJson(`/api/platform/runs/${runId}/cancel`, {})
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled' })
  })
  it('exports reviewed incomplete results with disclaimers and deletes only this group', async () => {
    const review = await postJson(`/api/platform/runs/${runId}/review`, {
      reviewer: 'Internal fixture operator',
      notes: 'All diagnostics were intentionally unexecuted.',
      nextSupport: 'Obtain explicit permission and perform manual approved smoke testing.',
    })
    expect(review.status).toBe(200)
    const report = await fetch(`/api/platform/runs/${runId}/report.md`)
    expect(report.status).toBe(200)
    expect(report.headers.get('cache-control')).toContain('no-store')
    const markdown = await report.text()
    expect(markdown).toContain('安全性を保証するものではありません')
    expect(markdown).toContain('not-run')
    expect(markdown).toContain('次に提案する支援')
    expect((await fetch(`/api/platform/groups/${groupId}`, { method: 'DELETE' })).status).toBe(200)
    expect((await fetch(`/api/platform/runs/${runId}`)).status).toBe(404)
  })
})
