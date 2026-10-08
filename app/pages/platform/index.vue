<script setup lang="ts">
import type { PlatformGroup } from '#shared/types/platform'

const { data: groups, refresh } = await useFetch<PlatformGroup[]>('/api/platform/groups', {
  default: () => [],
})

const form = reactive({
  customer: '',
  name: '',
  targets: '',
  exclusions: '',
  ports: '22, 80, 443',
  tlsPorts: '443',
  redisPorts: '',
  location: 'external' as 'external' | 'lan' | 'vpn',
  concurrency: 2,
  connectionsPerSecond: 2,
  timeoutSeconds: 3,
  maxMinutes: 5,
})
const submitting = ref(false)
const errorMessage = ref<string | null>(null)

function parsePorts(value: string): number[] {
  if (!value.trim()) return []
  const parts = value.split(',').map((part) => part.trim())
  if (!parts.every((part) => /^\d{1,5}$/.test(part) && Number(part) >= 1 && Number(part) <= 65535))
    throw new Error('ポートは1〜65535の整数をカンマ区切りで入力してください。')
  return [...new Set(parts.map(Number))]
}

async function createGroup() {
  submitting.value = true
  errorMessage.value = null
  try {
    const group = await $fetch<PlatformGroup>('/api/platform/groups', {
      method: 'POST',
      body: {
        ...form,
        ports: parsePorts(form.ports),
        tlsPorts: parsePorts(form.tlsPorts),
        redisPorts: parsePorts(form.redisPorts),
      },
    })
    await refresh()
    await navigateTo(`/platform/groups/${group.id}`)
  } catch (error) {
    errorMessage.value = toApiErrorMessage(error)
  } finally {
    submitting.value = false
  }
}

const locationLabel = (location: PlatformGroup['config']['location']) =>
  ({ external: '外部', lan: '社内LAN', vpn: 'VPN経由' })[location]
</script>

<template>
  <div>
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="text-caption-md text-mute">社内担当者向け・低負荷プロファイル</p>
        <h1 class="font-display text-heading-xl uppercase">プラットフォーム簡易チェック</h1>
      </div>
    </div>

    <p class="mt-3 max-w-3xl text-body-md text-mute">
      許可されたTCPポートの到達性・サービス・TLS・限定した既知脆弱性を確認します。安全性を保証する検査ではなく、UDP探索、侵入テスト、DoS、認証総当たりは行いません。
    </p>

    <form class="card mt-6 space-y-6" data-testid="platform-form" @submit.prevent="createGroup">
      <div>
        <h2 class="font-display text-heading-lg uppercase">対象を登録</h2>
        <p class="mt-1 text-caption-md text-mute">
          登録時に名前解決とCIDR展開を行い、実行前に固定された対象一覧を確認します。登録だけでは検査を開始しません。
        </p>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <label class="text-caption-md"
          >顧客名<input v-model="form.customer" required maxlength="120" class="input-pill mt-1"
        /></label>
        <label class="text-caption-md"
          >チェック名<input v-model="form.name" required maxlength="120" class="input-pill mt-1"
        /></label>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <label class="text-caption-md">
          対象（1行にホスト名・IP・IPv4 CIDRを1件）
          <textarea
            v-model="form.targets"
            required
            rows="7"
            class="textarea-soft mt-1"
            placeholder="server.example.jp&#10;192.0.2.10&#10;192.0.2.16/30"
          />
        </label>
        <label class="text-caption-md">
          除外対象（1行1件）
          <textarea
            v-model="form.exclusions"
            rows="7"
            class="textarea-soft mt-1"
            placeholder="192.0.2.18"
          />
        </label>
      </div>

      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label class="text-caption-md"
          >TCPポート（カンマ区切り）<input
            v-model="form.ports"
            required
            class="input-pill mt-1"
            inputmode="numeric"
        /></label>
        <label class="text-caption-md"
          >TLS確認ポート（TCPの部分集合）<input
            v-model="form.tlsPorts"
            class="input-pill mt-1"
            inputmode="numeric"
        /></label>
        <label class="text-caption-md"
          >実行場所（担当者申告）
          <select v-model="form.location" class="input-pill mt-1">
            <option value="external">外部</option>
            <option value="lan">社内LAN</option>
            <option value="vpn">VPN経由</option>
          </select>
        </label>
        <label class="text-caption-md"
          >時間上限（分）<input
            v-model.number="form.maxMinutes"
            type="number"
            min="1"
            max="30"
            class="input-pill mt-1"
        /></label>
      </div>

      <label class="block text-caption-md"
        >Redisと確認済みでPING検査を許可するポート（任意、カンマ区切り）
        <input
          v-model="form.redisPorts"
          data-testid="redis-ports"
          class="input-pill mt-1"
          placeholder="例: 6379（空欄ならPINGを送信しません）"
        />
        <span class="mt-1 block text-mute"
          >対象TCPポートの一部を指定してください。指定先にはPINGのみを送信し、データ取得・認証試行は行いません。</span
        >
      </label>
      <details>
        <summary class="cursor-pointer text-caption-md font-medium">低負荷設定</summary>
        <div class="mt-4 grid gap-4 sm:grid-cols-3">
          <label class="text-caption-md"
            >同時実行数<input
              v-model.number="form.concurrency"
              type="number"
              min="1"
              max="4"
              class="input-pill mt-1"
          /></label>
          <label class="text-caption-md"
            >接続数/秒<input
              v-model.number="form.connectionsPerSecond"
              type="number"
              min="1"
              max="5"
              class="input-pill mt-1"
          /></label>
          <label class="text-caption-md"
            >1接続の上限（秒）<input
              v-model.number="form.timeoutSeconds"
              type="number"
              min="1"
              max="10"
              class="input-pill mt-1"
          /></label>
        </div>
      </details>

      <p v-if="errorMessage" role="alert" class="text-body-md text-sale">{{ errorMessage }}</p>
      <button class="btn-primary" type="submit" :disabled="submitting">
        {{ submitting ? '対象を確認中…' : '登録して対象一覧を確認' }}
      </button>
    </form>

    <section class="mt-10">
      <h2 class="font-display text-heading-lg uppercase">登録済みチェック</h2>
      <div
        v-if="groups.length === 0"
        data-testid="platform-empty"
        class="card mt-4 text-body-md text-mute"
      >
        登録済みの対象はありません。
      </div>
      <ul v-else class="mt-4 grid gap-4 sm:grid-cols-2">
        <li v-for="group in groups" :key="group.id" class="card flex flex-col gap-2">
          <NuxtLink
            :to="`/platform/groups/${group.id}`"
            class="font-display text-heading-md uppercase"
            >{{ group.config.name }}</NuxtLink
          >
          <p class="text-body-md">{{ group.config.customer }}</p>
          <p class="text-caption-md text-mute">
            {{ locationLabel(group.config.location) }}（担当者申告）・{{
              group.scope.hostCount
            }}台・{{ group.scope.endpointCount }}エンドポイント
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>
