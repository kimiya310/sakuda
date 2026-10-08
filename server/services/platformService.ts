import { platformControllers } from './platformActivity'
import { and, asc, desc, eq, inArray, lt, or, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { platformGroups, platformRuns } from '../db/schema'
import { resolvePlatformScope, type PlatformResolver } from '../domain/platformScope'
import { ServiceError } from './errors'
import {
  PlatformInputSchema,
  PlatformStartSchema,
  PlatformReviewSchema,
  type PlatformInput,
  type PlatformStart,
  type PlatformReviewInput,
} from '#shared/schemas/platform'
import type {
  PlatformGroup,
  PlatformRun,
  PlatformDetail,
  PlatformDiff,
  PlatformFinding,
} from '#shared/types/platform'

export interface PlatformDeps {
  db: Db
  now: () => Date
  id: () => string
  resolver?: PlatformResolver
}
export async function createPlatformGroup(
  deps: PlatformDeps,
  value: PlatformInput,
): Promise<PlatformGroup> {
  const config = PlatformInputSchema.parse(value)
  const scope = await resolvePlatformScope(config, deps.now, deps.resolver)
  const group = { id: deps.id(), config, scope, createdAt: deps.now().toISOString() }
  deps.db.insert(platformGroups).values(group).run()
  return group
}
export function getPlatformGroup(db: Db, id: string): PlatformGroup {
  const row = db.select().from(platformGroups).where(eq(platformGroups.id, id)).get()
  if (!row) throw new ServiceError(404, 'PLATFORM_NOT_FOUND', 'Platform group not found')
  return row
}
export function listPlatformGroups(db: Db): PlatformGroup[] {
  return db.select().from(platformGroups).orderBy(desc(platformGroups.createdAt)).all()
}
export function listPlatformRuns(db: Db, groupId: string): PlatformRun[] {
  getPlatformGroup(db, groupId)
  return db
    .select()
    .from(platformRuns)
    .where(eq(platformRuns.groupId, groupId))
    .orderBy(desc(platformRuns.createdAt), desc(platformRuns.id))
    .all()
}
export function getPlatformRun(db: Db, id: string): PlatformRun {
  const row = db.select().from(platformRuns).where(eq(platformRuns.id, id)).get()
  if (!row) throw new ServiceError(404, 'PLATFORM_RUN_NOT_FOUND', 'Platform run not found')
  return row
}
export function createPlatformRun(
  deps: PlatformDeps,
  groupId: string,
  value: PlatformStart,
): PlatformRun {
  const authorization = PlatformStartSchema.parse(value)
  const group = getPlatformGroup(deps.db, groupId)
  const scope = group.scope
  if (deps.now().getTime() - Date.parse(scope.preparedAt) > 15 * 60000)
    throw new ServiceError(422, 'SCOPE_EXPIRED', 'Refresh the resolved scope and confirm it again')
  if (
    scope.hostCount !== authorization.expectedHostCount ||
    scope.scopeToken !== authorization.scopeToken
  )
    throw new ServiceError(
      422,
      'SCOPE_CHANGED',
      'Preview and confirm the current scope before execution',
    )
  const now = deps.now()
  if (
    Date.parse(authorization.windowStart) > now.getTime() ||
    Date.parse(authorization.windowEnd) <= now.getTime()
  )
    throw new ServiceError(
      422,
      'AUTHORIZATION_WINDOW',
      'Execution must be within the authorized time window',
    )
  return deps.db.transaction((tx) => {
    const active = tx
      .select({ id: platformRuns.id })
      .from(platformRuns)
      .where(
        and(
          eq(platformRuns.groupId, groupId),
          or(
            inArray(platformRuns.status, ['queued', 'running']),
            and(eq(platformRuns.status, 'cancelled'), isNull(platformRuns.finishedAt)),
          ),
        ),
      )
      .get()
    if (active)
      throw new ServiceError(409, 'PLATFORM_ACTIVE', 'This group already has an active job')
    const run: PlatformRun = {
      id: deps.id(),
      groupId,
      status: 'queued',
      snapshot: group.config,
      scope,
      authorization,
      result: {
        endpoints: scope.assets.flatMap(({ host, address }) =>
          [...new Set(group.config.ports)].map((port) => ({
            host,
            address,
            port,
            status: 'not-run' as const,
            service: null,
            product: null,
            version: null,
            tls: null,
            coverage: {
              tcp: 'not-run' as const,
              tls: 'not-run' as const,
              version: 'not-run' as const,
              networkTemplate: 'not-run' as const,
            },
            notes: ['Queued; no diagnostic traffic has been sent.'],
          })),
        ),
        findings: [],
        warnings: [],
      },
      review: null,
      createdAt: now.toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
    }
    tx.insert(platformRuns).values(run).run()
    return run
  })
}
export function claimNextPlatformRun(db: Db, now: () => Date): string | null {
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(platformRuns)
      .where(eq(platformRuns.status, 'queued'))
      .orderBy(asc(platformRuns.createdAt))
      .limit(1)
      .get()
    if (!row) return null
    const claimed = tx
      .update(platformRuns)
      .set({ status: 'running', startedAt: now().toISOString() })
      .where(and(eq(platformRuns.id, row.id), eq(platformRuns.status, 'queued')))
      .run()
    return claimed.changes > 0 ? row.id : null
  })
}
export function recoverPlatformRuns(db: Db, now: () => Date): number {
  const finishedAt = now().toISOString()
  const running = db
    .update(platformRuns)
    .set({
      status: 'failed',
      error: 'Server restarted; incomplete checks are not evidence of resolution',
      finishedAt,
    })
    .where(eq(platformRuns.status, 'running'))
    .run().changes
  const stopping = db
    .update(platformRuns)
    .set({
      error: 'Server restarted while stopping; incomplete checks remain unverified',
      finishedAt,
    })
    .where(and(eq(platformRuns.status, 'cancelled'), isNull(platformRuns.finishedAt)))
    .run().changes
  return running + stopping
}
// The DB flag also reaches a running job in another process; runner polls it and aborts transports.
export function cancelPlatformRun(db: Db, id: string, now: () => Date): PlatformRun {
  getPlatformRun(db, id)
  // Compare-and-set each state independently: a worker may claim between requests.
  const queued = db
    .update(platformRuns)
    .set({
      status: 'cancelled',
      finishedAt: now().toISOString(),
      error: 'Stopped before execution; checks remain unverified',
    })
    .where(and(eq(platformRuns.id, id), eq(platformRuns.status, 'queued')))
    .run()
  if (queued.changes === 0) {
    db.update(platformRuns)
      .set({
        status: 'cancelled',
        finishedAt: null,
        error: 'Stopping; remaining checks are unverified',
      })
      .where(and(eq(platformRuns.id, id), eq(platformRuns.status, 'running')))
      .run()
  }
  platformControllers.get(id)?.abort()
  return getPlatformRun(db, id)
}

export function reviewPlatformRun(
  db: Db,
  id: string,
  value: PlatformReviewInput,
  now: () => Date,
): PlatformRun {
  const run = getPlatformRun(db, id)
  if (!run.finishedAt || platformControllers.has(id))
    throw new ServiceError(
      409,
      'PLATFORM_RUNNING',
      'Review is only available after execution finishes',
    )
  const input = PlatformReviewSchema.parse(value)
  db.update(platformRuns)
    .set({ review: { ...input, reviewedAt: now().toISOString() } })
    .where(eq(platformRuns.id, id))
    .run()
  return getPlatformRun(db, id)
}
export function deletePlatformGroup(db: Db, id: string): void {
  getPlatformGroup(db, id)
  const groupRuns = db
    .select({ id: platformRuns.id })
    .from(platformRuns)
    .where(eq(platformRuns.groupId, id))
    .all()
  if (groupRuns.some((r) => platformControllers.has(r.id)))
    throw new ServiceError(
      409,
      'PLATFORM_STOPPING',
      'Wait for the worker to stop before deleting this group',
    )
  if (
    db
      .select({ id: platformRuns.id })
      .from(platformRuns)
      .where(
        and(
          eq(platformRuns.groupId, id),
          or(
            inArray(platformRuns.status, ['queued', 'running']),
            and(eq(platformRuns.status, 'cancelled'), isNull(platformRuns.finishedAt)),
          ),
        ),
      )
      .get()
  )
    throw new ServiceError(
      409,
      'PLATFORM_ACTIVE',
      'Stop active jobs and wait for the worker before deleting this group',
    )
  db.delete(platformGroups).where(eq(platformGroups.id, id)).run()
}
export function purgePlatformHistory(db: Db, now: () => Date, retentionDays: number): number {
  const cutoff = new Date(now().getTime() - retentionDays * 86400000).toISOString()
  return db
    .delete(platformRuns)
    .where(
      and(
        lt(platformRuns.finishedAt, cutoff),
        inArray(platformRuns.status, ['done', 'failed', 'cancelled']),
      ),
    )
    .run().changes
}
function wasRechecked(run: PlatformRun, finding: PlatformFinding, profile: string): boolean {
  const endpoint = run.result.endpoints.find(
    (e) => e.host === finding.host && e.address === finding.address && e.port === finding.port,
  )
  const phase =
    finding.check === 'network-template'
      ? 'networkTemplate'
      : finding.check === 'tls'
        ? 'tls'
        : 'version'
  // A missing/changed address, closed port, failed run or unsupported check is never remediation proof.
  return (
    run.status === 'done' &&
    run.snapshot.profile === profile &&
    endpoint?.status === 'open' &&
    endpoint.coverage[phase] === 'done'
  )
}
export function platformRunDetail(db: Db, id: string): PlatformDetail {
  const run = getPlatformRun(db, id)
  const history = db
    .select()
    .from(platformRuns)
    .where(and(eq(platformRuns.groupId, run.groupId), lt(platformRuns.createdAt, run.createdAt)))
    .orderBy(asc(platformRuns.createdAt))
    .all()
  const outstanding = new Map<string, { finding: PlatformFinding; profile: string }>()
  // Carry unresolved findings across incomplete intermediate runs, not just the immediate previous JSON blob.
  for (const earlier of history) {
    const present = new Set(earlier.result.findings.map((f) => f.key))
    for (const [key, { finding: f, profile }] of outstanding) {
      if (!present.has(key) && wasRechecked(earlier, f, profile)) outstanding.delete(key)
    }
    for (const f of earlier.result.findings)
      outstanding.set(f.key, { finding: f, profile: earlier.snapshot.profile })
  }
  const diff: PlatformDiff = {
    previousRunId: history.at(-1)?.id ?? null,
    added: [],
    persisting: [],
    resolved: [],
    unverified: [],
  }
  const keys = new Set(run.result.findings.map((f) => f.key))
  for (const f of run.result.findings)
    (outstanding.has(f.key) ? diff.persisting : diff.added).push(f)
  for (const { finding: f, profile } of outstanding.values()) {
    if (keys.has(f.key)) continue
    ;(wasRechecked(run, f, profile) ? diff.resolved : diff.unverified).push(f)
  }
  return { ...run, diff }
}

export async function refreshPlatformScope(
  deps: PlatformDeps,
  groupId: string,
): Promise<PlatformGroup> {
  const group = getPlatformGroup(deps.db, groupId)
  const scope = await resolvePlatformScope(group.config, deps.now, deps.resolver)
  deps.db.update(platformGroups).set({ scope }).where(eq(platformGroups.id, groupId)).run()
  return { ...group, scope }
}
