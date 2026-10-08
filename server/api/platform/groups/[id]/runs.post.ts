import { defineEventHandler, setResponseStatus } from 'h3'
import { platformDeps } from '../../../../lib/platformDeps'
import { parseBody, requireParam, toHttpError } from '../../../../lib/http'
import { createPlatformRun } from '../../../../services/platformService'
import { PlatformStartSchema } from '#shared/schemas/platform'
export default defineEventHandler(async (event) => {
  const input = await parseBody(event, PlatformStartSchema)
  try {
    const run = createPlatformRun(platformDeps(), requireParam(event, 'id'), input)
    setResponseStatus(event, 201)
    return run
  } catch (e) {
    toHttpError(e)
  }
})
