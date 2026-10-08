import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { platformDeps } from '../../../../lib/platformDeps'
import { parseBody, requireParam, toHttpError } from '../../../../lib/http'
import { cancelPlatformRun } from '../../../../services/platformService'
export default defineEventHandler(async (event) => {
  await parseBody(event, z.object({}))
  const deps = platformDeps()
  try {
    return cancelPlatformRun(deps.db, requireParam(event, 'id'), deps.now)
  } catch (e) {
    toHttpError(e)
  }
})
