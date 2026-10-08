import { defineEventHandler } from 'h3'
import { platformDeps } from '../../../lib/platformDeps'
import { toHttpError } from '../../../lib/http'
import { listPlatformGroups } from '../../../services/platformService'
export default defineEventHandler(() => {
  const deps = platformDeps()
  try {
    return listPlatformGroups(deps.db)
  } catch (e) {
    toHttpError(e)
  }
})
