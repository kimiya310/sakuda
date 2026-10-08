import { defineEventHandler, setHeader } from 'h3'
import { platformDeps } from '../../../../lib/platformDeps'
import { requireParam, toHttpError } from '../../../../lib/http'
import { platformRunDetail } from '../../../../services/platformService'
import { ServiceError } from '../../../../services/errors'
import { platformMarkdown } from '../../../../domain/platformReport'
export default defineEventHandler((event) => {
  try {
    const run = platformRunDetail(platformDeps().db, requireParam(event, 'id'))
    if (!run.review)
      throw new ServiceError(
        409,
        'REVIEW_REQUIRED',
        '担当者が結果を確認してからレポートを出力してください',
      )
    setHeader(event, 'content-type', 'text/markdown; charset=utf-8')
    setHeader(event, 'content-disposition', 'attachment; filename="platform-report.md"')
    setHeader(event, 'cache-control', 'private, no-store')
    return platformMarkdown(run)
  } catch (e) {
    toHttpError(e)
  }
})
