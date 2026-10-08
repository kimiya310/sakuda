import type { PlatformInput, PlatformStart, PlatformReviewInput } from '../schemas/platform'

export interface PlatformScope {
  assets: { host: string; address: string }[]
  preparedAt: string
  estimatedSeconds: number
  requestBudget: number
  hosts: string[]
  excluded: string[]
  hostCount: number
  endpointCount: number
  scopeToken: string
}
export interface PlatformGroup {
  id: string
  config: PlatformInput
  scope: PlatformScope
  createdAt: string
}
export type PlatformClassification = 'confirmed' | 'inferred' | 'needs-review'
export interface PlatformFinding {
  key: string
  host: string
  address: string
  port: number
  check: 'tls' | 'version' | 'network-template'
  ruleId: string
  name: string
  classification: PlatformClassification
  evidence: string
  remediation: string
}
export interface PlatformEndpoint {
  host: string
  address: string | null
  port: number
  status: 'open' | 'closed' | 'unreachable' | 'not-run' | 'excluded'
  service: string | null
  product: string | null
  version: string | null
  tls: {
    protocol: string
    cipher: string
    subject: string
    issuer: string
    validTo: string
    authorized: boolean
  } | null
  coverage: Record<
    'tcp' | 'tls' | 'version' | 'networkTemplate',
    'done' | 'not-applicable' | 'failed' | 'cancelled' | 'not-run'
  >
  notes: string[]
}
export interface PlatformResult {
  endpoints: PlatformEndpoint[]
  findings: PlatformFinding[]
  warnings: string[]
}
export interface PlatformRun {
  id: string
  groupId: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  snapshot: PlatformInput
  scope: PlatformScope
  authorization: PlatformStart
  result: PlatformResult
  review: (PlatformReviewInput & { reviewedAt: string }) | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}
export interface PlatformDiff {
  previousRunId: string | null
  added: PlatformFinding[]
  persisting: PlatformFinding[]
  resolved: PlatformFinding[]
  unverified: PlatformFinding[]
}
export interface PlatformDetail extends PlatformRun {
  diff: PlatformDiff
}
