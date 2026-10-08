<script setup lang="ts">
import type { PlatformGroup, PlatformRun } from '#shared/types/platform'

interface GroupDetail {
  group: PlatformGroup
  runs: PlatformRun[]
}
const route = useRoute()
const id = String(route.params.id ?? '')
const {
  data,
  error: loadError,
  refresh: refreshDetail,
} = await useFetch<GroupDetail>(`/api/platform/groups/${id}`)

const auth = reactive({
  administrator: '',
  authorizationReference: '',
  windowStart: '',
  windowEnd: '',
  permissionConfirmed: false,
  segmentsConfirmed: false,
  manifestConfirmed: false,
})
const refreshing = ref(false)
const starting = ref(false)
const deleting = ref(false)
const actionError = ref<string | null>(null)

const activeRun = computed(
  () =>
    data.value?.runs.some(
      (run) =>
        run.status === 'queued' ||
        run.status === 'running' ||
        (run.status === 'cancelled' && !run.finishedAt),
    ) ?? false,
)
const scopeExpiresAt = computed(() => {
  const prepared = data.value?.group.scope.preparedAt
  return prepared ? new Date(new Date(prepared).getTime() + 15 * 60 * 1000).toISOString() : ''
})
const locationLabel = computed(
  () =>
    ({ external: '外部', lan: '社内LAN', vpn: 'VPN経由' })[
      data.value?.group.config.location ?? 'external'
    ],
)

async function refreshScope() {
  refreshing.value = true
  actionError.value = null
  try {
    await $fetch(`/api/platform/groups/${id}/preview`, { method: 'POST', body: {} })
    auth.manifestConfirmed = false
    await refreshDetail()
  } catch (error) {
    actionError.value = toApiErrorMessage(error)
  } finally {
    refreshing.value = false
  }
}

async function startRun() {
  const group = data.value?.group
  if (!group) return
  starting.value = true
  actionError.value = null
  try {
    const run = await $fetch<PlatformRun>(`/api/platform/groups/${id}/runs`, {
      method: 'POST',
      body: {
        scopeToken: group.scope.scopeToken,
        expectedHostCount: group.scope.hostCount,
        administrator: auth.administrator,
        authorizationReference: auth.authorizationReference,
        windowStart: new Date(auth.windowStart).toISOString(),
        windowEnd: new Date(auth.windowEnd).toISOString(),
        permissionConfirmed: auth.permissionConfirmed,
        segmentsConfirmed: auth.segmentsConfirmed,
      },
    })
    await navigateTo(`/platform/runs/${run.id}`)
  } catch (error) {
    actionError.value = toApiErrorMessage(error)
  } finally {
    starting.value = false
  }
}

async function deleteGroup() {
  if (!window.confirm('この登録と履歴を削除します。元に戻せません。削除しますか？')) return
  deleting.value = true
  actionError.value = null
  try {
    await $fetch(`/api/platform/groups/${id}`, { method: 'DELETE' })
    await navigateTo('/platform')
  } catch (error) {
    actionError.value = toApiErrorMessage(error)
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div v-if="data">
    <NuxtLink to="/platform" class="text-caption-md underline">← 一覧へ</NuxtLink>
    <div class="mt-3 flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="text-caption-md text-mute">{{ data.group.config.customer }}</p>
        <h1 class="font-display text-heading-xl uppercase">{{ data.group.config.name }}</h1>
      </div>
      <button class="btn-secondary" :disabled="activeRun || deleting" @click="deleteGroup">
        {{ deleting ? '削除中…' : '登録を削除' }}
      </button>
    </div>

    <section class="card mt-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 class="font-display text-heading-lg uppercase">固定された対象範囲</h2>
          <p class="mt-1 text-caption-md text-mute">
            名前解決結果は実行ごとに変えず、この一覧を検査します。有効期限は作成から15分です。
          </p>
        </div>
        <button class="btn-secondary" :disabled="refreshing || activeRun" @click="refreshScope">
          {{ refreshing ? '再確認中…' : '名前解決を再確認' }}
        </button>
      </div>
      <dl class="mt-4 grid gap-3 sm:grid-cols-4">
        <div>
          <dt class="text-caption-sm text-mute">実行場所</dt>
          <dd>{{ locationLabel }}（担当者申告）</dd>
        </div>
        <div>
          <dt class="text-caption-sm text-mute">対象</dt>
          <dd>{{ data.group.scope.hostCount }}台</dd>
        </div>
        <div>
          <dt class="text-caption-sm text-mute">エンドポイント</dt>
          <dd>{{ data.group.scope.endpointCount }}件</dd>
        </div>
        <div>
          <dt class="text-caption-sm text-mute">推定時間</dt>
          <dd>概算 {{ data.group.scope.estimatedSeconds }}秒（時間上限は別）</dd>
        </div>
      </dl>
      <p class="mt-3 text-caption-md text-mute">
        固定日時: {{ data.group.scope.preparedAt }} ／ 実行受付期限: {{ scopeExpiresAt }} ／
        最大リクエスト予算:
        {{ data.group.scope.requestBudget }}
      </p>
      <p class="mt-3 text-caption-md">
        Redis PINGの明示許可ポート:
        {{ data.group.config.redisPorts.join(', ') || 'なし（PING未実施）' }}
      </p>
      <div class="mt-4 overflow-x-auto">
        <table class="w-full text-left text-caption-md">
          <thead class="border-b border-hairline">
            <tr>
              <th class="py-2 pr-4">入力ホスト</th>
              <th class="py-2 pr-4">固定IP</th>
              <th class="py-2">対象ポート</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="asset in data.group.scope.assets"
              :key="`${asset.host}-${asset.address}`"
              class="border-b border-hairline-soft"
            >
              <td class="py-2 pr-4 font-mono">{{ asset.host }}</td>
              <td class="py-2 pr-4 font-mono">{{ asset.address }}</td>
              <td class="py-2">{{ data.group.config.ports.join(', ') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <details v-if="data.group.scope.excluded.length" class="mt-4">
        <summary class="cursor-pointer text-caption-md">
          除外対象 {{ data.group.scope.excluded.length }}件
        </summary>
        <ul class="mt-2 list-disc pl-5 font-mono text-caption-md">
          <li v-for="item in data.group.scope.excluded" :key="item">{{ item }}</li>
        </ul>
      </details>
    </section>

    <form class="card mt-6 space-y-5" data-testid="start-platform-run" @submit.prevent="startRun">
      <div>
        <h2 class="font-display text-heading-lg uppercase">実施確認と開始</h2>
        <p class="mt-1 text-caption-md text-mute">
          管理者の許可、対象セグメント、実施時間帯を記録します。
        </p>
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="text-caption-md"
          >許可した管理者<input
            v-model="auth.administrator"
            required
            class="input-pill mt-1" /></label
        ><label class="text-caption-md"
          >許可記録・チケット番号<input
            v-model="auth.authorizationReference"
            required
            class="input-pill mt-1"
        /></label>
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="text-caption-md"
          >開始予定<input
            v-model="auth.windowStart"
            required
            type="datetime-local"
            class="input-pill mt-1" /></label
        ><label class="text-caption-md"
          >終了予定<input
            v-model="auth.windowEnd"
            required
            type="datetime-local"
            class="input-pill mt-1"
        /></label>
      </div>
      <div class="space-y-3 text-body-md">
        <label class="flex items-start gap-3"
          ><input v-model="auth.manifestConfirmed" type="checkbox" class="mt-1" /><span
            ><strong
              >{{ data.group.scope.hostCount }}台（CIDR展開・名前解決後）の固定対象一覧</strong
            >とポートを確認しました</span
          ></label
        >
        <label class="flex items-start gap-3"
          ><input v-model="auth.permissionConfirmed" type="checkbox" class="mt-1" /><span
            >対象管理者から、この範囲と時間帯で実施する許可を得ました</span
          ></label
        >
        <label class="flex items-start gap-3"
          ><input v-model="auth.segmentsConfirmed" type="checkbox" class="mt-1" /><span
            >{{ locationLabel }}から対象セグメントへ診断可能であることを事前確認しました</span
          ></label
        >
      </div>
      <p v-if="actionError" role="alert" class="text-body-md text-sale">{{ actionError }}</p>
      <button
        class="btn-primary"
        type="submit"
        :disabled="
          starting ||
          activeRun ||
          !auth.manifestConfirmed ||
          !auth.permissionConfirmed ||
          !auth.segmentsConfirmed
        "
      >
        {{
          starting ? '開始中…' : activeRun ? '実行中のチェックがあります' : '低負荷チェックを開始'
        }}
      </button>
    </form>

    <section class="mt-8">
      <h2 class="font-display text-heading-lg uppercase">履歴</h2>
      <p v-if="data.runs.length === 0" class="card mt-4 text-body-md text-mute">
        実行履歴はありません。
      </p>
      <ul v-else class="mt-4 space-y-3">
        <li
          v-for="run in data.runs"
          :key="run.id"
          class="card flex flex-wrap items-center justify-between gap-3"
        >
          <div>
            <NuxtLink :to="`/platform/runs/${run.id}`" class="font-medium underline">{{
              run.createdAt
            }}</NuxtLink>
            <p class="text-caption-md text-mute">
              {{ run.status }}・{{ run.result.findings.length }}件
            </p>
          </div>
        </li>
      </ul>
    </section>
  </div>
  <p v-else-if="loadError" role="alert" class="text-sale">{{ toApiErrorMessage(loadError) }}</p>
</template>
