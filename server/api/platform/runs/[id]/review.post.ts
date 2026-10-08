import { defineEventHandler } from 'h3'
import { platformDeps } from '../../../../lib/platformDeps'
import { parseBody, requireParam, toHttpError } from '../../../../lib/http'
import { reviewPlatformRun } from '../../../../services/platformService'
import { PlatformReviewSchema } from '#shared/schemas/platform'
export default defineEventHandler(async (event) => {
  const input = await parseBody(event, PlatformReviewSchema)
  const deps = platformDeps()
  try {
    return reviewPlatformRun(deps.db, requireParam(event, 'id'), input, deps.now)
  } catch (e) {
    toHttpError(e)
  }
})
