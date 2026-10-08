import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import PlatformIndex from '~/pages/platform/index.vue'
import PlatformGroupPage from '~/pages/platform/groups/[id].vue'
import PlatformRunPage from '~/pages/platform/runs/[id].vue'
import type { PlatformDetail, PlatformGroup, PlatformRun } from '#shared/types/platform'

const scope = {
  assets: [
    { host: 'edge.example.test', address: '192.0.2.10' },
    { host: '192.0.2.16/31', address: '192.0.2.16' },
    { host: '192.0.2.16/31', address: '192.0.2.17' },
  ],
  preparedAt: '2026-10-09T01:00:00.000Z',
  estimatedSeconds: 18,
  requestBudget: 27,
  hosts: ['edge.example.test', '192.0.2.16', '192.0.2.17'],
  excluded: ['192.0.2.18'],
  hostCount: 3,
  endpointCount: 9,
  scopeToken: 'a'.repeat(64),
}

const config = {
  profile: 'sales-tcp-v1' as const,
  customer: 'Example Customer',
  name: 'External perimeter',
  targets: 'edge.example.test\n192.0.2.16/31',
  exclusions: '192.0.2.18',
  ports: [22, 80, 443],
  tlsPorts: [443],
  redisPorts: [],
  location: 'external' as const,
  concurrency: 2,
  connectionsPerSecond: 2,
  timeoutSeconds: 3,
  maxMinutes: 5,
}

const group: PlatformGroup = {
  id: 'group-1',
  config,
  scope,
  createdAt: '2026-10-09T01:00:00.000Z',
}

const baseRun: PlatformRun = {
  id: 'run-1',
  groupId: group.id,
  status: 'done',
  snapshot: config,
  scope,
  authorization: {
    expectedHostCount: 3,
    scopeToken: scope.scopeToken,
    administrator: 'Network Owner',
    authorizationReference: 'TICKET-123',
    windowStart: '2026-10-09T02:00:00.000Z',
    windowEnd: '2026-10-09T03:00:00.000Z',
    permissionConfirmed: true,
    segmentsConfirmed: true,
  },
  result: {
    endpoints: [
      {
        host: 'edge.example.test',
        address: '192.0.2.10',
        port: 443,
        status: 'open',
        service: 'https',
        product: 'Example Server',
        version: '1.0',
        tls: {
          protocol: 'TLSv1.3',
          cipher: 'TLS_AES_256_GCM_SHA384',
          subject: 'CN=edge.example.test',
          issuer: 'Example CA',
          validTo: '2027-01-01T00:00:00.000Z',
          authorized: true,
        },
        coverage: { tcp: 'done', tls: 'done', version: 'done', networkTemplate: 'done' },
        notes: [],
      },
    ],
    findings: [
      {
        key: 'confirmed-1',
        host: 'edge.example.test',
        address: '192.0.2.10',
        port: 443,
        check: 'tls',
        ruleId: 'tls-expiry',
        name: 'Certificate expires soon',
        classification: 'confirmed',
        evidence: 'Certificate validity was read during the check.',
        remediation: 'Renew the certificate.',
      },
      {
        key: 'inferred-1',
        host: 'edge.example.test',
        address: '192.0.2.10',
        port: 443,
        check: 'version',
        ruleId: 'version-review',
        name: 'Version requires confirmation',
        classification: 'inferred',
        evidence: 'Banner version only.',
        remediation: 'Confirm the installed package version.',
      },
    ],
    warnings: [],
  },
  review: null,
  createdAt: '2026-10-09T02:00:00.000Z',
  startedAt: '2026-10-09T02:00:01.000Z',
  finishedAt: '2026-10-09T02:00:20.000Z',
  error: null,
}

describe('platform pages', () => {
  beforeEach(() => clearNuxtData())

  it('registers targets separately from execution and explains the safe initial scope', async () => {
    registerEndpoint('/api/platform/groups', () => [])
    const wrapper = await mountSuspended(PlatformIndex)

    expect(wrapper.get('[data-testid="platform-form"]').text()).toContain(
      '登録だけでは検査を開始しません',
    )
    expect(wrapper.get('[data-testid="redis-ports"]').attributes('placeholder')).toContain(
      '空欄ならPINGを送信しません',
    )
    expect(wrapper.text()).toContain('UDP探索、侵入テスト、DoS、認証総当たりは行いません')
    expect(wrapper.get('[data-testid="platform-empty"]').text()).toContain(
      '登録済みの対象はありません',
    )
  })

  it('shows the pinned CIDR-expanded manifest and requires all three confirmations', async () => {
    registerEndpoint('/api/platform/groups/group-1', () => ({ group, runs: [] }))
    const wrapper = await mountSuspended(PlatformGroupPage, { route: '/platform/groups/group-1' })

    expect(wrapper.text()).toContain('3台（CIDR展開・名前解決後）の固定対象一覧')
    expect(wrapper.text()).toContain('192.0.2.16')
    expect(wrapper.text()).toContain('Redis PINGの明示許可ポート: なし（PING未実施）')
    const button = wrapper.get('form[data-testid="start-platform-run"] button[type="submit"]')
    expect((button.element as HTMLButtonElement).disabled).toBe(true)

    for (const checkbox of wrapper.findAll(
      'form[data-testid="start-platform-run"] input[type="checkbox"]',
    )) {
      await checkbox.setValue(true)
    }
    expect((button.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('separates confirmed and inferred findings and withholds the report before review', async () => {
    const detail: PlatformDetail = {
      ...baseRun,
      diff: {
        previousRunId: 'run-0',
        added: [],
        persisting: [],
        resolved: [],
        unverified: baseRun.result.findings.slice(1),
      },
    }
    registerEndpoint('/api/platform/runs/run-1', () => detail)
    const wrapper = await mountSuspended(PlatformRunPage, { route: '/platform/runs/run-1' })
    await flushPromises()

    expect(wrapper.text()).toContain('検査で確認')
    expect(wrapper.text()).toContain('バージョン等からの推定')
    expect(wrapper.text()).toContain('未実行・接続失敗・中止された範囲は「解消」ではなく「未確認」')
    expect(wrapper.find('a[href="/api/platform/runs/run-1/report.md"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('顧客へ提示する前に')
  })
})
