<script setup lang="ts">
import type { PlatformDetail, PlatformFinding, PlatformRun } from '#shared/types/platform'

const route = useRoute()
const id = String(route.params.id ?? '')
const poller = usePolling(
  () => $fetch<PlatformDetail>(`/api/platform/runs/${id}`),
  (run) => ['done', 'failed', 'cancelled'].includes(run.status) && run.finishedAt !== null,
)
const { state: run, error: pollError, start, stop } = poller
onMounted(start)

const cancelling = ref(false)
const reviewing = ref(false)
const actionError = ref<string | null>(null)
const review = reactive({ reviewer: '', notes: '', nextSupport: '' })

const active = computed(
  () =>
    run.value?.status === 'queued' ||
    run.value?.status === 'running' ||
    (run.value?.status === 'cancelled' && !run.value.finishedAt),
)
const confirmed = computed(
  () => run.value?.result.findings.filter((f) => f.classification === 'confirmed') ?? [],
)
const needsReview = computed(
  () => run.value?.result.findings.filter((f) => f.classification !== 'confirmed') ?? [],
)
const coverageLabel = (status: string) =>
  ({
    done: '確認済み',
    'not-applicable': '対象外',
    failed: '失敗',
    cancelled: '中止',
    'not-run': '未実行',
  })[status] ?? status

async function cancelRun() {
  cancelling.value = true
  actionError.value = null
  try {
    await $fetch(`/api/platform/runs/${id}/cancel`, { method: 'POST', body: {} })
    stop()
    start()
  } catch (error) {
    actionError.value = toApiErrorMessage(error)
  } finally {
    cancelling.value = false
  }
}

async function submitReview() {
  reviewing.value = true
  actionError.value = null
  try {
    const updated = await $fetch<PlatformRun>(`/api/platform/runs/${id}/review`, {
      method: 'POST',
      body: review,
    })
    run.value = {
      ...updated,
      diff: run.value?.diff ?? {
        previousRunId: null,
        added: [],
        persisting: [],
        resolved: [],
        unverified: [],
      },
    }
  } catch (error) {
    actionError.value = toApiErrorMessage(error)
  } finally {
    reviewing.value = false
  }
}

function findingTitle(finding: PlatformFinding) {
  return `${finding.host}:${finding.port} — ${finding.name}`
}
</script>

<template>
  <div>
    <p v-if="pollError" role="alert" class="text-sale">{{ pollError }}</p>
    <div v-else-if="!run" class="card text-body-md text-mute">結果を読み込んでいます…</div>
    <template v-else>
      <NuxtLink :to="`/platform/groups/${run.groupId}`" class="text-caption-md underline"
        >← 対象範囲へ</NuxtLink
      >
      <div class="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="text-caption-md text-mute">{{ run.snapshot.customer }}</p>
          <h1 class="font-display text-heading-xl uppercase">{{ run.snapshot.name }} 結果</h1>
        </div>
        <span class="badge">{{ run.status }}</span>
      </div>
      <p class="mt-3 text-body-md text-mute">
        これは許可された範囲の簡易チェック結果です。対象全体の安全性を保証するものではありません。
      </p>
      <div v-if="active" class="card mt-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p class="font-medium">低負荷チェックを実行中です</p>
          <p class="text-caption-md text-mute">
            時間上限 {{ run.snapshot.maxMinutes }}分・いつでも停止できます。
          </p>
        </div>
        <button
          class="btn-secondary"
          :disabled="cancelling || run.status === 'cancelled'"
          @click="cancelRun"
        >
          {{ cancelling || run.status === 'cancelled' ? '停止中…' : '停止' }}
        </button>
      </div>
      <p v-if="run.error" class="mt-4 text-body-md text-sale">{{ run.error }}</p>
      <div v-if="run.result.warnings.length" class="card mt-4">
        <h2 class="font-display text-heading-md uppercase">未確認範囲・警告</h2>
        <ul class="mt-2 list-disc pl-5 text-caption-md">
          <li v-for="warning in run.result.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </div>
      <p v-if="actionError" role="alert" class="mt-4 text-body-md text-sale">{{ actionError }}</p>

      <section class="mt-8">
        <h2 class="font-display text-heading-lg uppercase">確認できた問題</h2>
        <p v-if="confirmed.length === 0" class="card mt-4 text-body-md text-mute">
          検査で確認された指摘はありません。「問題なし」を意味するものではありません。
        </p>
        <ul v-else class="mt-4 space-y-3">
          <li v-for="finding in confirmed" :key="finding.key" class="card">
            <div class="flex flex-wrap gap-2">
              <span class="badge">検査で確認</span
              ><span class="text-caption-md text-mute">{{ finding.check }}</span>
            </div>
            <h3 class="mt-2 font-medium">{{ findingTitle(finding) }}</h3>
            <p class="mt-2 text-caption-md"><strong>根拠:</strong> {{ finding.evidence }}</p>
            <p class="mt-2 text-caption-md"><strong>対処:</strong> {{ finding.remediation }}</p>
          </li>
        </ul>
      </section>

      <section class="mt-8">
        <h2 class="font-display text-heading-lg uppercase">追加確認が必要な事項</h2>
        <p v-if="needsReview.length === 0" class="card mt-4 text-body-md text-mute">
          追加確認に分類された指摘はありません。
        </p>
        <ul v-else class="mt-4 space-y-3">
          <li v-for="finding in needsReview" :key="finding.key" class="card">
            <span class="badge">{{
              finding.classification === 'inferred' ? 'バージョン等からの推定' : '要確認'
            }}</span>
            <h3 class="mt-2 font-medium">{{ findingTitle(finding) }}</h3>
            <p class="mt-2 text-caption-md"><strong>根拠:</strong> {{ finding.evidence }}</p>
            <p class="mt-2 text-caption-md"><strong>対処:</strong> {{ finding.remediation }}</p>
          </li>
        </ul>
      </section>

      <section class="mt-8">
        <h2 class="font-display text-heading-lg uppercase">ホスト・ポート・サービス</h2>
        <p class="mt-2 text-caption-md text-mute">
          Ping応答の有無だけでは除外しません。接続拒否はホスト到達性の根拠になり得ますが、ポート開放とは扱いません。
        </p>
        <div class="mt-4 overflow-x-auto">
          <table class="w-full text-left text-caption-md">
            <thead class="border-b border-hairline">
              <tr>
                <th class="py-2 pr-3">ホスト / IP</th>
                <th class="py-2 pr-3">ポート</th>
                <th class="py-2 pr-3">状態</th>
                <th class="py-2 pr-3">サービス / 製品</th>
                <th class="py-2 pr-3">TLS</th>
                <th class="py-2">確認範囲</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="endpoint in run.result.endpoints"
                :key="`${endpoint.address}-${endpoint.port}`"
                class="border-b border-hairline-soft align-top"
              >
                <td class="py-3 pr-3">
                  <span class="font-medium">{{ endpoint.host }}</span
                  ><br /><span class="font-mono text-mute">{{ endpoint.address ?? '未解決' }}</span>
                </td>
                <td class="py-3 pr-3">{{ endpoint.port }}</td>
                <td class="py-3 pr-3">{{ endpoint.status }}</td>
                <td class="py-3 pr-3">
                  {{ endpoint.service ?? '不明' }}<br /><span class="text-mute">{{
                    [endpoint.product, endpoint.version].filter(Boolean).join(' ') ||
                    '製品・バージョン未取得'
                  }}</span>
                </td>
                <td class="py-3 pr-3">
                  <span v-if="endpoint.tls"
                    >{{ endpoint.tls.protocol }} / {{ endpoint.tls.cipher }}<br />期限
                    {{ endpoint.tls.validTo }}</span
                  ><span v-else>—</span>
                </td>
                <td class="py-3">
                  <ul>
                    <li v-for="(value, key) in endpoint.coverage" :key="key">
                      {{ key }}: {{ coverageLabel(value) }}
                    </li>
                  </ul>
                  <ul v-if="endpoint.notes.length" class="mt-1 list-disc pl-4 text-mute">
                    <li v-for="note in endpoint.notes" :key="note">{{ note }}</li>
                  </ul>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="mt-8">
        <h2 class="font-display text-heading-lg uppercase">前回との差分</h2>
        <div class="card mt-4 grid gap-4 sm:grid-cols-4">
          <div>
            <p class="text-caption-sm text-mute">新規</p>
            <p class="text-heading-lg">{{ run.diff.added.length }}</p>
          </div>
          <div>
            <p class="text-caption-sm text-mute">継続</p>
            <p class="text-heading-lg">{{ run.diff.persisting.length }}</p>
          </div>
          <div>
            <p class="text-caption-sm text-mute">解消確認</p>
            <p class="text-heading-lg">{{ run.diff.resolved.length }}</p>
          </div>
          <div>
            <p class="text-caption-sm text-mute">未確認</p>
            <p class="text-heading-lg">{{ run.diff.unverified.length }}</p>
          </div>
        </div>
        <p class="mt-2 text-caption-md text-mute">
          未実行・接続失敗・中止された範囲は「解消」ではなく「未確認」に分類します。
        </p>
      </section>

      <section class="card mt-8">
        <h2 class="font-display text-heading-lg uppercase">担当者レビューと次に提案する支援</h2>
        <div v-if="run.review" class="mt-4 space-y-2 text-body-md">
          <p><strong>確認者:</strong> {{ run.review.reviewer }}（{{ run.review.reviewedAt }}）</p>
          <p class="whitespace-pre-wrap"><strong>確認メモ:</strong> {{ run.review.notes }}</p>
          <p class="whitespace-pre-wrap"><strong>次の支援:</strong> {{ run.review.nextSupport }}</p>
          <a :href="`/api/platform/runs/${id}/report.md`" class="btn-primary mt-3"
            >レビュー済みレポートをダウンロード</a
          >
        </div>
        <form v-else class="mt-4 space-y-4" @submit.prevent="submitReview">
          <p class="text-caption-md text-mute">
            機密情報を含む可能性があります。顧客へ提示する前に、自動判定の根拠・未確認範囲・保存先を確認してください。
          </p>
          <label class="block text-caption-md"
            >確認者<input v-model="review.reviewer" required class="input-pill mt-1" /></label
          ><label class="block text-caption-md"
            >確認メモ<textarea
              v-model="review.notes"
              required
              rows="4"
              class="textarea-soft mt-1"
            /></label
          ><label class="block text-caption-md"
            >次に提案する支援<textarea
              v-model="review.nextSupport"
              required
              rows="4"
              class="textarea-soft mt-1"
            /></label
          ><button class="btn-primary" :disabled="reviewing || active" type="submit">
            {{ reviewing ? '保存中…' : 'レビューを保存' }}
          </button>
          <p v-if="active" class="text-caption-md text-mute">実行完了後にレビューできます。</p>
        </form>
      </section>
    </template>
  </div>
</template>
