import { platformControllers } from './platformActivity'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { platformRuns } from '../db/schema'
import { getPlatformRun } from './platformService'
import type { PlatformRun, PlatformResult } from '#shared/types/platform'

export type PlatformCheck = (run: PlatformRun, signal: AbortSignal) => Promise<PlatformResult>
export interface PlatformRunnerDeps {
  db: Db
  now: () => Date
  platformCheck: PlatformCheck
}
export async function runPlatform(
  deps: PlatformRunnerDeps,
  id: string,
  parentSignal: AbortSignal,
): Promise<void> {
  const run = getPlatformRun(deps.db, id)
  if (run.status !== 'running') return
  const controller = new AbortController()
  platformControllers.set(id, controller)
  const abort = () => controller.abort()
  parentSignal.addEventListener('abort', abort, { once: true })
  const remaining = Math.min(
    run.snapshot.maxMinutes * 60000,
    Date.parse(run.authorization.windowEnd) - deps.now().getTime(),
  )
  let timedOut = remaining <= 0
  const deadline = setTimeout(
    () => {
      timedOut = true
      abort()
    },
    Math.max(0, remaining),
  )
  const poll = setInterval(() => {
    if (getPlatformRun(deps.db, id).status === 'cancelled') abort()
  }, 100)
  if (parentSignal.aborted || timedOut) abort()
  try {
    if (Date.parse(run.authorization.windowStart) > deps.now().getTime())
      throw new Error('Authorization window has not started')
    if (timedOut) throw new Error('Authorization window expired before execution')
    const result = await deps.platformCheck(run, controller.signal)
    const current = getPlatformRun(deps.db, id)
    const cancelled = current.status === 'cancelled' || parentSignal.aborted
    deps.db
      .update(platformRuns)
      .set({
        status: cancelled ? 'cancelled' : timedOut ? 'failed' : 'done',
        result,
        finishedAt: deps.now().toISOString(),
        error: cancelled
          ? 'Stopped; incomplete checks remain unverified'
          : timedOut
            ? 'Time limit reached; incomplete checks remain unverified'
            : null,
      })
      .where(eq(platformRuns.id, id))
      .run()
  } catch {
    // Do not serialize transport/tool exception messages (they may contain banners or secrets).
    const cancelled = getPlatformRun(deps.db, id).status === 'cancelled' || parentSignal.aborted
    deps.db
      .update(platformRuns)
      .set({
        status: cancelled ? 'cancelled' : 'failed',
        finishedAt: deps.now().toISOString(),
        error: timedOut
          ? 'Authorization window or time limit expired'
          : 'Platform engine failed; results are incomplete',
      })
      .where(eq(platformRuns.id, id))
      .run()
  } finally {
    platformControllers.delete(id)
    clearInterval(poll)
    clearTimeout(deadline)
    parentSignal.removeEventListener('abort', abort)
  }
}
