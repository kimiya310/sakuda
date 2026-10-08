import { defineEventHandler } from 'h3'
import { platformDeps } from '../../../lib/platformDeps'
import { requireParam, toHttpError } from '../../../lib/http'
import { deletePlatformGroup } from '../../../services/platformService'
export default defineEventHandler((event) => {
  const deps = platformDeps()
  try {
    deletePlatformGroup(deps.db, requireParam(event, 'id'))
    return { deleted: true }
  } catch (e) {
    toHttpError(e)
  }
})
