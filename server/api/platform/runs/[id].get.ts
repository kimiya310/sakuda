import { defineEventHandler } from 'h3'
import { platformDeps } from '../../../lib/platformDeps'
import { requireParam, toHttpError } from '../../../lib/http'
import { platformRunDetail } from '../../../services/platformService'
export default defineEventHandler((event) => {
  const deps = platformDeps()
  try {
    return platformRunDetail(deps.db, requireParam(event, 'id'))
  } catch (e) {
    toHttpError(e)
  }
})
