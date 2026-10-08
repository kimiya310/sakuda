import type { PlatformDetail, PlatformFinding } from '#shared/types/platform'

function safe(value: string): string {
  return value.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}[\]()<>|#!]/g, '\\$&')
}
function findingLine(f: PlatformFinding): string {
  return `- ${safe(f.host)} (${safe(f.address)}):${f.port} — ${safe(f.name)}\n  - 根拠: ${safe(f.evidence)}\n  - 対処: ${safe(f.remediation)}`
}
export function platformMarkdown(run: PlatformDetail): string {
  const confirmed = run.result.findings.filter((f) => f.classification === 'confirmed')
  const verify = run.result.findings.filter((f) => f.classification !== 'confirmed')
  return (
    [
      `# プラットフォーム簡易チェック: ${safe(run.snapshot.name)}`,
      `顧客: ${safe(run.snapshot.customer)} / 状態: ${run.status}`,
      `実行場所: ${run.snapshot.location} / 実行開始: ${run.startedAt ?? '未実行'}`,
      `実施許可: ${safe(run.authorization.administrator)} / ${safe(run.authorization.authorizationReference)}`,
      `許可時間帯: ${run.authorization.windowStart} ～ ${run.authorization.windowEnd}`,
      `対象: ${run.scope.hostCount}台 / TCPポート: ${run.snapshot.ports.join(', ')} / 除外: ${safe(run.snapshot.exclusions) || 'なし'}`,
      `自動除外・明示除外対象: ${run.scope.excluded.map(safe).join(', ') || 'なし'}`,
      `固定プロファイル: ${safe(run.snapshot.profile)} / Redis PING明示許可ポート: ${run.snapshot.redisPorts.join(', ') || 'なし（PING未実施）'}`,
      '本結果は簡易チェックで確認した範囲に限られ、安全性を保証するものではありません。未検出は脆弱性がないことを意味しません。',
      `担当者確認: ${run.review ? `${safe(run.review.reviewer)} / ${run.review.reviewedAt}` : '未確認（社内ドラフト）'}`,
      run.review ? `確認メモ: ${safe(run.review.notes)}` : '',
      '## 確認できた問題',
      ...confirmed.map(findingLine),
      confirmed.length ? '' : '確認済みの指摘なし（安全性の保証ではありません）。',
      '## 追加確認が必要な事項',
      ...verify.map(
        (f) =>
          `${findingLine(f)}\n  - 区分: ${f.classification === 'inferred' ? 'バージョン等からの推定' : '要確認'}`,
      ),
      '## ホスト・ポートと未確認範囲',
      ...run.result.endpoints.map(
        (e) =>
          `- ${safe(e.host)}:${e.port} / IP: ${safe(e.address ?? '未解決')} / ${e.status} / サービス: ${safe(e.service ?? '不明')} / 製品: ${safe(e.product ?? '不明')} / バージョン: ${safe(e.version ?? '不明')}\n  - TLS: ${e.tls ? safe(`${e.tls.protocol} ${e.tls.cipher}; issuer=${e.tls.issuer}; subject=${e.tls.subject}; expires=${e.tls.validTo}`) : '未確認'}\n  - 検査完了: TCP=${e.coverage.tcp}, TLS=${e.coverage.tls}, バージョン=${e.coverage.version}, 限定テンプレート=${e.coverage.networkTemplate}\n  - 補足: ${e.notes.map(safe).join('; ') || 'なし'}`,
      ),
      ...run.result.warnings.map((w) => `- ${safe(w)}`),
      run.error ? `実行制約: ${safe(run.error)}` : '',
      '対象に選択していないポート、UDP、STARTTLS、OS内部設定、クラウド設定、認証付き検査、侵入テストは未検査です。TLSは単一のハンドシェイクであり全暗号スイートの網羅検査ではありません。',
      '## 前回との差分',
      `新規: ${run.diff.added.length} / 継続: ${run.diff.persisting.length} / 同じ検査で再確認し検出なし: ${run.diff.resolved.length} / 未確認: ${run.diff.unverified.length}`,
      ...run.diff.unverified.map(
        (f) => `- 未確認（解消ではない）: ${safe(f.host)}:${f.port} ${safe(f.name)}`,
      ),
      '## 次に提案する支援',
      run.review
        ? safe(run.review.nextSupport)
        : '担当者による結果確認の後、対策支援・本格診断の提案を記入してください。',
    ]
      .filter((s) => s !== '')
      .join('\n\n') + '\n'
  )
}
