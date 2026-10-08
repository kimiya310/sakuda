import { defineEventHandler, setResponseStatus } from 'h3'
import { platformDeps } from '../../../lib/platformDeps'
import { parseBody, toHttpError } from '../../../lib/http'
import { createPlatformGroup } from '../../../services/platformService'
import { PlatformInputSchema } from '#shared/schemas/platform'
export default defineEventHandler(async (event) => {
  const input = await parseBody(event, PlatformInputSchema)
  try {
    const group = await createPlatformGroup(platformDeps(), input)
    setResponseStatus(event, 201)
    return group
  } catch (e) {
    toHttpError(e)
  }
})
