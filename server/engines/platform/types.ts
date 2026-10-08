import type { PlatformResult, PlatformRun } from '#shared/types/platform'

export type PlatformCoverageStatus = 'done' | 'not-applicable' | 'failed' | 'cancelled' | 'not-run'

export interface TcpProbeInput {
  address: string
  port: number
  timeoutMs: number
  maxBytes: number
  signal: AbortSignal
}

export interface TcpProbeResult {
  status: 'open' | 'closed' | 'unreachable'
  banner?: Uint8Array
}

export interface TlsProbeInput {
  address: string
  host: string
  port: number
  timeoutMs: number
  signal: AbortSignal
}

export interface TlsProbeResult {
  protocol: string
  cipher: string
  subject: string
  issuer: string
  validTo: string
  authorized: boolean
  expired: boolean
  notYetValid: boolean
  hostnameMismatch: boolean
}

export interface NetworkTemplateInput {
  address: string
  port: number
  timeoutMs: number
  signal: AbortSignal
  nucleiBin: string
}

export interface NetworkTemplateResult {
  completed: boolean
  matched: boolean
}

export interface PlatformCheckOptions {
  tcpProbe?: (input: TcpProbeInput) => Promise<TcpProbeResult>
  tlsProbe?: (input: TlsProbeInput) => Promise<TlsProbeResult>
  networkTemplate?: (input: NetworkTemplateInput) => Promise<NetworkTemplateResult>
  nucleiBin?: string
  now?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export type PlatformCheck = (
  run: PlatformRun,
  signal: AbortSignal,
  options?: PlatformCheckOptions,
) => Promise<PlatformResult>
