import { defineEventHandler } from 'h3'
import { platformDeps } from '../../../lib/platformDeps'
import { requireParam, toHttpError } from '../../../lib/http'
import { getPlatformGroup, listPlatformRuns } from '../../../services/platformService'
export default defineEventHandler((event) => {
  const deps = platformDeps()
  try {
    const id = requireParam(event, 'id')
    return { group: getPlatformGroup(deps.db, id), runs: listPlatformRuns(deps.db, id) }
  } catch (e) {
    toHttpError(e)
  }
})
