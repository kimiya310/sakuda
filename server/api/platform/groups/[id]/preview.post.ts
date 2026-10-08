import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { platformDeps } from '../../../../lib/platformDeps'
import { parseBody, requireParam, toHttpError } from '../../../../lib/http'
import { refreshPlatformScope } from '../../../../services/platformService'
export default defineEventHandler(async (event) => {
  await parseBody(event, z.object({}))
  try {
    return await refreshPlatformScope(platformDeps(), requireParam(event, 'id'))
  } catch (e) {
    toHttpError(e)
  }
})
