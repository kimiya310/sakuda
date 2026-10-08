import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { PlatformInputSchema } from '#shared/schemas/platform'
import type {
  PlatformEndpoint,
  PlatformFinding,
  PlatformGroup,
  PlatformResult,
} from '#shared/types/platform'
import { openDatabase, type Db } from '../../db/client'
import { platformGroups, platformRuns } from '../../db/schema'
import { platformMarkdown } from '../../domain/platformReport'
import { listActiveJobs } from '../activeJobs'
import {
  cancelPlatformRun,
  claimNextPlatformRun,
  createPlatformGroup,
  createPlatformRun,
  deletePlatformGroup,
  getPlatformRun,
  listPlatformRuns,
  platformRunDetail,
  purgePlatformHistory,
  recoverPlatformRuns,
  refreshPlatformScope,
  reviewPlatformRun,
} from '../platformService'
import { runPlatform } from '../platformRunner'
import { platformControllers } from '../platformActivity'

vi.mock('node:dns/promises', () => ({
  lookup: () => {
    throw new Error('Real DNS forbidden')
  },
}))
let db: Db
let group: PlatformGroup
let sequence: number
let clock: number
const now = () => new Date(clock)
const deps = () => ({ db, now, id: () => `platform-${++sequence}` })
const config = PlatformInputSchema.parse({
  customer: 'Customer fixture',
  name: 'LAN fixture',
  targets: '10.0.0.1',
  exclusions: '',
  ports: [22],
  tlsPorts: [],
  location: 'lan',
})
const consent = () => ({
  expectedHostCount: group.scope.hostCount,
  scopeToken: group.scope.scopeToken,
  administrator: 'Owner fixture',
  authorizationReference: 'Written approval fixture',
  windowStart: '2026-01-01T00:00:00Z',
  windowEnd: '2026-01-01T01:00:00Z',
  permissionConfirmed: true as const,
  segmentsConfirmed: true as const,
})
const finding: PlatformFinding = {
  key: '10.0.0.1:22:CVE-fixture',
  host: '10.0.0.1',
  address: '10.0.0.1',
  port: 22,
  check: 'version',
  ruleId: 'CVE-fixture',
  name: 'Version-only fixture',
  classification: 'inferred',
  evidence: 'Synthetic banner version',
  remediation: 'Confirm package patch status',
}
const endpoint = (patch: Partial<PlatformEndpoint> = {}): PlatformEndpoint => ({
  host: '10.0.0.1',
  address: '10.0.0.1',
  port: 22,
  status: 'open',
  service: 'ssh',
  product: 'OpenSSH',
  version: '9.6',
  tls: null,
  coverage: {
    tcp: 'done',
    tls: 'not-applicable',
    version: 'done',
    networkTemplate: 'not-applicable',
  },
  notes: [],
  ...patch,
})
const result = (findings: PlatformFinding[] = [], observation = endpoint()): PlatformResult => ({
  endpoints: [observation],
  findings,
  warnings: [],
})
function completed(value: PlatformResult, status: 'done' | 'failed' | 'cancelled' = 'done') {
  clock += 1000
  const run = createPlatformRun(deps(), group.id, consent())
  db.update(platformRuns)
    .set({ result: value, status, finishedAt: now().toISOString() })
    .where(eq(platformRuns.id, run.id))
    .run()
  return run.id
}

beforeEach(async () => {
  sequence = 0
  clock = Date.parse('2026-01-01T00:01:00Z')
  db = openDatabase({
    file: ':memory:',
    migrationsFolder: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
  })
  group = await createPlatformGroup(deps(), config)
})
afterEach(() => platformControllers.clear())

describe('platform persistence, control and reporting (isolated in-memory DB)', () => {
  it('snapshots confirmed scope, queues without executing, and shares queue projection', () => {
    const run = createPlatformRun(deps(), group.id, consent())
    expect(run.status).toBe('queued')
    expect(run.scope.assets).toEqual(group.scope.assets)
    expect(run.result.endpoints[0]?.coverage.tcp).toBe('not-run')
    expect(listActiveJobs(db)).toEqual([
      expect.objectContaining({
        kind: 'platform',
        id: run.id,
        siteName: 'Customer fixture / LAN fixture',
      }),
    ])
    expect(() => createPlatformRun(deps(), group.id, consent())).toThrow('active job')
  })
  it('requires fresh exact scope count/digest and current written authorization', async () => {
    expect(() =>
      createPlatformRun(deps(), group.id, { ...consent(), expectedHostCount: 2 }),
    ).toThrow('Preview')
    expect(() =>
      createPlatformRun(deps(), group.id, { ...consent(), permissionConfirmed: false as never }),
    ).toThrow()
    expect(() =>
      createPlatformRun(deps(), group.id, { ...consent(), windowEnd: '2025-12-31T23:59:00Z' }),
    ).toThrow()
    clock += 16 * 60000
    expect(() => createPlatformRun(deps(), group.id, consent())).toThrow('Refresh')
    group = await refreshPlatformScope(deps(), group.id)
    expect(createPlatformRun(deps(), group.id, consent()).status).toBe('queued')
  })
  it('cancels queued jobs atomically and cannot claim them', () => {
    const run = createPlatformRun(deps(), group.id, consent())
    expect(cancelPlatformRun(db, run.id, now).status).toBe('cancelled')
    expect(claimNextPlatformRun(db, now)).toBeNull()
  })
  it('does not execute an expired queued authorization window', async () => {
    const run = createPlatformRun(deps(), group.id, consent())
    claimNextPlatformRun(db, now)
    clock = Date.parse('2026-01-01T02:00:00Z')
    const platformCheck = vi.fn()
    await runPlatform({ db, now, platformCheck }, run.id, new AbortController().signal)
    expect(platformCheck).not.toHaveBeenCalled()
    expect(getPlatformRun(db, run.id)).toMatchObject({
      status: 'failed',
      result: { endpoints: [expect.objectContaining({ status: 'not-run' })] },
    })
  })
  it('aborts running work, preserves partial results, and prevents delete/review until stopped', async () => {
    const run = createPlatformRun(deps(), group.id, consent())
    claimNextPlatformRun(db, now)
    let sawAbort = false
    const running = runPlatform(
      {
        db,
        now,
        platformCheck: async (_run, signal) =>
          new Promise<PlatformResult>((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                sawAbort = true
                resolve(result([finding]))
              },
              { once: true },
            ),
          ),
      },
      run.id,
      new AbortController().signal,
    )
    cancelPlatformRun(db, run.id, now)
    cancelPlatformRun(db, run.id, now)
    expect(getPlatformRun(db, run.id).finishedAt).toBeNull()
    expect(() => createPlatformRun(deps(), group.id, consent())).toThrow('active job')
    expect(() => deletePlatformGroup(db, group.id)).toThrow('worker')
    expect(() =>
      reviewPlatformRun(
        db,
        run.id,
        { reviewer: 'Owner', notes: 'Check fixture', nextSupport: 'Patch review' },
        now,
      ),
    ).toThrow()
    await running
    expect(sawAbort).toBe(true)
    expect(getPlatformRun(db, run.id)).toMatchObject({
      status: 'cancelled',
      result: { findings: [finding] },
    })
    expect(platformControllers.size).toBe(0)
    deletePlatformGroup(db, group.id)
    expect(db.select().from(platformRuns).all()).toEqual([])
  })
  it('sanitizes engine failures rather than storing transport secrets', async () => {
    const run = createPlatformRun(deps(), group.id, consent())
    claimNextPlatformRun(db, now)
    await runPlatform(
      {
        db,
        now,
        platformCheck: async () => {
          throw new Error('fixture-super-secret')
        },
      },
      run.id,
      new AbortController().signal,
    )
    expect(JSON.stringify(getPlatformRun(db, run.id))).not.toContain('fixture-super-secret')
    expect(getPlatformRun(db, run.id).status).toBe('failed')
  })
  it.each(['unreachable', 'closed', 'not-run', 'excluded'] as const)(
    'never resolves absent findings when endpoint is %s',
    (status) => {
      completed(result([finding]))
      const id = completed(result([], endpoint({ status })))
      expect(platformRunDetail(db, id).diff).toMatchObject({ resolved: [], unverified: [finding] })
    },
  )
  it('carries outstanding findings through failed intermediate runs and changed addresses', () => {
    completed(result([finding]))
    completed(result(), 'failed')
    const id = completed(result([], endpoint({ address: '10.0.0.2' })))
    expect(platformRunDetail(db, id).diff.unverified).toEqual([finding])
  })
  it('resolves only completed comparable checks and not unsupported or failed coverage', () => {
    completed(result([finding]))
    const failed = completed(
      result(
        [],
        endpoint({
          coverage: {
            tcp: 'done',
            tls: 'not-applicable',
            version: 'failed',
            networkTemplate: 'not-applicable',
          },
        }),
      ),
    )
    expect(platformRunDetail(db, failed).diff.resolved).toEqual([])
    const id = completed(result())
    expect(platformRunDetail(db, id).diff.resolved).toEqual([finding])
    const next = completed(result())
    expect(platformRunDetail(db, next).diff.resolved).toEqual([])
  })
  it('isolates customer groups in history and review/report output', async () => {
    const id = completed(result([finding]))
    const other = await createPlatformGroup(deps(), { ...config, customer: 'Other fixture' })
    expect(listPlatformRuns(db, other.id)).toEqual([])
    const review = reviewPlatformRun(
      db,
      id,
      {
        reviewer: 'Operator',
        notes: 'Version inference verified as needing administrator review',
        nextSupport: 'Package review and full authorized assessment',
      },
      now,
    )
    expect(review.review?.reviewer).toBe('Operator')
    const md = platformMarkdown(platformRunDetail(db, id))
    expect(md).toContain('確認できた問題')
    expect(md).toContain('追加確認が必要な事項')
    expect(md).toContain('次に提案する支援')
    expect(md).toContain('安全性を保証するものではありません')
    expect(md).toContain('バージョン等からの推定')
    expect(md).not.toContain('Other fixture')
  })
  it('recovers interrupted jobs and purges only old terminal history', () => {
    const id = completed(result())
    const active = createPlatformRun(deps(), group.id, consent())
    claimNextPlatformRun(db, now)
    clock += 31 * 86400000
    expect(purgePlatformHistory(db, now, 30)).toBe(1)
    expect(
      db
        .select()
        .from(platformRuns)
        .all()
        .map((r) => r.id),
    ).toEqual([active.id])
    expect(() => getPlatformRun(db, id)).toThrow()
    expect(recoverPlatformRuns(db, now)).toBe(1)
    expect(getPlatformRun(db, active.id).status).toBe('failed')
    expect(db.select().from(platformGroups).all()).toHaveLength(1)
  })
})

describe('profile comparison guard', () => {
  it('does not resolve a finding produced by another rule/profile revision', () => {
    const older = completed(result([finding]))
    const oldRun = getPlatformRun(db, older)
    db.update(platformRuns)
      .set({ snapshot: { ...oldRun.snapshot, profile: 'older-profile' as never } })
      .where(eq(platformRuns.id, older))
      .run()
    const current = completed(result())
    expect(platformRunDetail(db, current).diff.unverified).toEqual([finding])
    expect(platformRunDetail(db, current).diff.resolved).toEqual([])
  })
})

describe('cancellation claim race', () => {
  it('keeps cancellation pending when the worker claims between initial read and update', () => {
    const run = createPlatformRun(deps(), group.id, consent())
    const raceClock = () => {
      claimNextPlatformRun(db, now)
      return now()
    }
    const stopped = cancelPlatformRun(db, run.id, raceClock)
    expect(stopped.status).toBe('cancelled')
    expect(stopped.finishedAt).toBeNull()
    expect(() => createPlatformRun(deps(), group.id, consent())).toThrow('active job')
    expect(() => deletePlatformGroup(db, group.id)).toThrow('Stop active')
    expect(() =>
      reviewPlatformRun(
        db,
        run.id,
        { reviewer: 'Operator', notes: 'Wait for transports', nextSupport: 'Manual validation' },
        now,
      ),
    ).toThrow()
  })
})
