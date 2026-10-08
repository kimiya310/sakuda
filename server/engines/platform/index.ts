import type {
  PlatformEndpoint,
  PlatformFinding,
  PlatformResult,
  PlatformRun,
} from '#shared/types/platform'
import { runRedisPingTemplate } from './networkTemplate'
import { probeTcp } from './tcp'
import { probeTls } from './tls'
import type {
  PlatformCheckOptions,
  PlatformCoverageStatus,
  TcpProbeResult,
  TlsProbeResult,
} from './types'

export * from './networkTemplate'
export * from './types'

export const PLATFORM_PROFILE = Object.freeze({
  id: 'sales-low-impact',
  revision: 1,
  tcpBannerMaxBytes: 512,
  networkTemplate: 'sakuda-redis-unauthenticated-ping-v1',
})

type Coverage = Record<'tcp' | 'tls' | 'version' | 'networkTemplate', PlatformCoverageStatus>
type MutableEndpoint = Omit<PlatformEndpoint, 'coverage'> & { coverage: Coverage }

const PORT_SERVICES: Readonly<Record<number, string>> = {
  22: 'ssh',
  25: 'smtp',
  80: 'http',
  110: 'pop3',
  143: 'imap',
  443: 'https',
  465: 'smtps',
  587: 'smtp',
  993: 'imaps',
  995: 'pop3s',
  3306: 'mysql',
  5432: 'postgresql',
  6379: 'redis',
  8443: 'https',
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const timer = setTimeout(done, milliseconds)
    function done(): void {
      signal.removeEventListener('abort', stop)
      resolve()
    }
    function stop(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      reject(abortError())
    }
    signal.addEventListener('abort', stop, { once: true })
  })
}

async function bounded<T>(
  timeoutMs: number,
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal.aborted) throw abortError()
  const controller = new AbortController()
  let rejectAbort: ((error: Error) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const parentAbort = (): void => {
    controller.abort()
    rejectAbort?.(abortError())
  }
  parentSignal.addEventListener('abort', parentAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('check deadline exceeded'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation(controller.signal), deadline, aborted])
  } finally {
    clearTimeout(timer)
    parentSignal.removeEventListener('abort', parentAbort)
  }
}

class RateGate {
  private nextAt = 0
  constructor(
    private readonly perSecond: number,
    private readonly now: () => number,
    private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  ) {}
  async take(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError()
    const at = Math.max(this.now(), this.nextAt)
    this.nextAt = at + 1000 / this.perSecond
    const wait = at - this.now()
    if (wait > 0) await this.sleep(wait, signal)
    if (signal.aborted) throw abortError()
  }
}

function detectService(
  result: TcpProbeResult,
  port: number,
): {
  service: string | null
  product: string | null
  version: string | null
  guessed: boolean
} {
  // ASCII-only decoding and a fixed input cap prevent raw binary/banner data
  // from entering results or logs.
  const text = result.banner
    ? Buffer.from(result.banner.subarray(0, PLATFORM_PROFILE.tcpBannerMaxBytes)).toString('latin1')
    : ''
  const ssh = /^SSH-\d\.\d-OpenSSH_([0-9]+(?:\.[0-9]+)?(?:p[0-9]+)?)/.exec(text)
  if (ssh) return { service: 'ssh', product: 'OpenSSH', version: ssh[1]!, guessed: false }
  if (/^(?:\+PONG|-NOAUTH)/i.test(text))
    return { service: 'redis', product: 'Redis', version: null, guessed: false }
  if (/^HTTP\/\d(?:\.\d)?\s/.test(text))
    return {
      service: port === 443 || port === 8443 ? 'https' : 'http',
      product: null,
      version: null,
      guessed: false,
    }
  const service = PORT_SERVICES[port] ?? null
  return { service, product: null, version: null, guessed: service !== null }
}

function openSshBefore96(version: string): boolean {
  const parsed = /^(\d+)\.(\d+)/.exec(version)
  return Boolean(
    parsed && (Number(parsed[1]) < 9 || (Number(parsed[1]) === 9 && Number(parsed[2]) < 6)),
  )
}

function finding(
  endpoint: MutableEndpoint,
  check: PlatformFinding['check'],
  ruleId: string,
  name: string,
  classification: PlatformFinding['classification'],
  evidence: string,
  remediation: string,
): PlatformFinding {
  return {
    key: `${endpoint.host}:${endpoint.address}:${endpoint.port}:${ruleId}`,
    host: endpoint.host,
    address: endpoint.address!,
    port: endpoint.port,
    check,
    ruleId,
    name,
    classification,
    evidence,
    remediation,
  }
}

function addTlsFindings(
  endpoint: MutableEndpoint,
  tls: TlsProbeResult,
  findings: PlatformFinding[],
): void {
  if (tls.expired)
    findings.push(
      finding(
        endpoint,
        'tls',
        'tls-certificate-expired',
        'Expired TLS certificate',
        'confirmed',
        `The certificate validity ended at ${tls.validTo}.`,
        'Replace the certificate and verify automated renewal.',
      ),
    )
  if (tls.hostnameMismatch)
    findings.push(
      finding(
        endpoint,
        'tls',
        'tls-hostname-mismatch',
        'TLS certificate name mismatch',
        'confirmed',
        'The observed certificate does not match the registered host name.',
        'Install a certificate whose subject alternative names include the registered host.',
      ),
    )
  if (tls.notYetValid)
    findings.push(
      finding(
        endpoint,
        'tls',
        'tls-certificate-not-yet-valid',
        'TLS certificate is not yet valid',
        'confirmed',
        'The observed certificate validity period starts in the future.',
        'Install the intended currently valid certificate and verify system time synchronization.',
      ),
    )
  if (!tls.authorized)
    findings.push(
      finding(
        endpoint,
        'tls',
        'tls-certificate-untrusted',
        'TLS certificate was not trusted',
        'needs-review',
        'The scanner environment did not authorize the observed certificate chain; a private trust anchor may be intentional.',
        'Confirm the intended trust model, then install a complete chain issued by an approved public or private trust anchor.',
      ),
    )
  if (tls.protocol === 'TLSv1' || tls.protocol === 'TLSv1.1')
    findings.push(
      finding(
        endpoint,
        'tls',
        'tls-legacy-protocol',
        'Legacy TLS protocol negotiated',
        'confirmed',
        `The bounded handshake negotiated ${tls.protocol}.`,
        'Disable TLS 1.0/1.1 and require TLS 1.2 or later.',
      ),
    )
  if (/(?:RC4|3DES|DES-CBC|NULL|EXPORT)/i.test(tls.cipher))
    findings.push(
      finding(
        endpoint,
        'tls',
        'tls-weak-cipher',
        'Weak TLS cipher negotiated',
        'confirmed',
        `The bounded handshake negotiated ${tls.cipher}.`,
        'Disable legacy cipher suites and prefer modern AEAD suites.',
      ),
    )
}

function cancelRemaining(endpoint: MutableEndpoint): void {
  if (endpoint.status === 'not-run') endpoint.notes.push('Not run because execution was stopped.')
  for (const key of Object.keys(endpoint.coverage) as (keyof Coverage)[]) {
    if (endpoint.coverage[key] === 'not-run') endpoint.coverage[key] = 'cancelled'
  }
}

export async function runPlatformChecks(
  run: PlatformRun,
  signal: AbortSignal,
  options: PlatformCheckOptions = {},
): Promise<PlatformResult> {
  const assets = run.scope.assets
  const endpoints: MutableEndpoint[] = assets.flatMap(({ host, address }) =>
    [...new Set(run.snapshot.ports)].map((port) => ({
      host,
      address,
      port,
      status: 'not-run' as const,
      service: null,
      product: null,
      version: null,
      tls: null,
      coverage: { tcp: 'not-run', tls: 'not-run', version: 'not-run', networkTemplate: 'not-run' },
      notes: [],
    })),
  )
  const findings: PlatformFinding[] = []
  const tcp = options.tcpProbe ?? probeTcp
  const tls = options.tlsProbe ?? probeTls
  const template = options.networkTemplate ?? runRedisPingTemplate
  const timeoutMs = run.snapshot.timeoutSeconds * 1000
  // Native probes enforce the configured transport timeout themselves. A
  // small wrapper grace lets them report timeout vs refusal accurately while
  // still bounding an injected dependency that ignores its signal.
  const dependencyDeadlineMs = timeoutMs + Math.min(250, Math.max(10, timeoutMs * 0.1))
  const gate = new RateGate(
    run.snapshot.connectionsPerSecond,
    options.now ?? Date.now,
    options.sleep ?? defaultSleep,
  )
  let cursor = 0

  async function execute(endpoint: MutableEndpoint): Promise<void> {
    if (signal.aborted) return cancelRemaining(endpoint)
    let tcpResult: TcpProbeResult
    try {
      await gate.take(signal)
      tcpResult = await bounded(dependencyDeadlineMs, signal, (phaseSignal) =>
        tcp({
          address: endpoint.address!,
          port: endpoint.port,
          timeoutMs,
          maxBytes: PLATFORM_PROFILE.tcpBannerMaxBytes,
          signal: phaseSignal,
        }),
      )
      endpoint.coverage.tcp = 'done'
      endpoint.status = tcpResult.status
    } catch (error) {
      endpoint.coverage.tcp = isAbort(error) || signal.aborted ? 'cancelled' : 'failed'
      endpoint.status = signal.aborted ? 'not-run' : 'unreachable'
      endpoint.notes.push(
        signal.aborted
          ? 'TCP check was stopped.'
          : 'TCP check failed without exposing transport details.',
      )
      if (signal.aborted) cancelRemaining(endpoint)
      return
    }
    if (tcpResult.status !== 'open') {
      endpoint.coverage.tls = 'not-applicable'
      endpoint.coverage.version = 'not-applicable'
      endpoint.coverage.networkTemplate = 'not-applicable'
      endpoint.notes.push(
        tcpResult.status === 'closed'
          ? 'Connection was refused or reset.'
          : 'Connection timed out or was unreachable.',
      )
      return
    }

    const detected = detectService(tcpResult, endpoint.port)
    endpoint.service = detected.service
    endpoint.product = detected.product
    endpoint.version = detected.version
    if (detected.guessed)
      endpoint.notes.push(
        'Service name is inferred from the selected port and requires confirmation.',
      )
    if (detected.product === 'OpenSSH' && detected.version) {
      endpoint.coverage.version = 'done'
      if (openSshBefore96(detected.version))
        findings.push(
          finding(
            endpoint,
            'version',
            'CVE-2023-48795',
            'OpenSSH version may be affected by Terrapin',
            'inferred',
            `OpenSSH ${detected.version} was identified. OpenSSH 9.6 release notes (2023-12-18) state that 9.6 contains mitigations for CVE-2023-48795; version evidence alone is not proof of exploitability. Source: https://www.openssh.com/txt/release-9.6`,
            'Check distributor backports, upgrade to a supported release, enable strict key exchange, review affected ciphers, and verify negotiation support on both peers.',
          ),
        )
    } else endpoint.coverage.version = 'not-applicable'

    if (run.snapshot.tlsPorts.includes(endpoint.port)) {
      if (signal.aborted) {
        cancelRemaining(endpoint)
        return
      }
      try {
        await gate.take(signal)
        const observed = await bounded(dependencyDeadlineMs, signal, (phaseSignal) =>
          tls({
            address: endpoint.address!,
            host: endpoint.host,
            port: endpoint.port,
            timeoutMs,
            signal: phaseSignal,
          }),
        )
        endpoint.tls = observed
        endpoint.coverage.tls = 'done'
        addTlsFindings(endpoint, observed, findings)
      } catch (error) {
        endpoint.coverage.tls = isAbort(error) || signal.aborted ? 'cancelled' : 'failed'
        endpoint.notes.push(
          signal.aborted ? 'TLS check was stopped.' : 'TLS handshake could not be analyzed.',
        )
        if (signal.aborted) {
          cancelRemaining(endpoint)
          return
        }
      }
    } else endpoint.coverage.tls = 'not-applicable'

    const redisEligible = run.snapshot.redisPorts.includes(endpoint.port)
    if (!redisEligible) endpoint.coverage.networkTemplate = 'not-applicable'
    else {
      if (signal.aborted) {
        cancelRemaining(endpoint)
        return
      }
      try {
        await gate.take(signal)
        // The network-template contract includes its own timeout and must not
        // resolve until its child process has exited; racing it here could
        // remove its private directory while the process is still alive.
        const outcome = await template({
          address: endpoint.address!,
          port: endpoint.port,
          timeoutMs,
          signal,
          nucleiBin: options.nucleiBin ?? 'nuclei',
        })
        endpoint.coverage.networkTemplate = outcome.completed ? 'done' : 'failed'
        if (!outcome.completed)
          endpoint.notes.push(
            'The approved Redis PING template did not complete; this check remains unverified.',
          )
        if (outcome.completed && outcome.matched)
          findings.push(
            finding(
              endpoint,
              'network-template',
              'redis-unauthenticated-ping',
              'Redis accepted unauthenticated PING',
              'needs-review',
              'The approved PING-only check received +PONG. No data-retrieval command was sent.',
              'Confirm the intended exposure and require network restriction and authentication where appropriate.',
            ),
          )
      } catch (error) {
        endpoint.coverage.networkTemplate =
          isAbort(error) || signal.aborted ? 'cancelled' : 'failed'
        endpoint.notes.push(
          signal.aborted
            ? 'Network template check was stopped.'
            : 'The approved network template failed; this check remains unverified.',
        )
        if (signal.aborted) cancelRemaining(endpoint)
      }
    }
  }

  async function worker(): Promise<void> {
    while (!signal.aborted) {
      const index = cursor++
      const endpoint = endpoints[index]
      if (!endpoint) return
      await execute(endpoint)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(run.snapshot.concurrency, endpoints.length) }, worker),
  )
  if (signal.aborted) endpoints.forEach(cancelRemaining)

  return {
    endpoints,
    findings,
    warnings: [
      `Platform profile ${run.snapshot.profile} (${PLATFORM_PROFILE.id}) revision ${PLATFORM_PROFILE.revision}; bounded TCP connection and passive banner observation, one active TLS handshake, OpenSSH version inference, and one active fixed Redis PING-only probe.`,
      'No ICMP, UDP discovery, arbitrary payloads, credential attacks, destructive checks, or full TLS cipher/protocol sweep were performed.',
      'Unrun, failed, unreachable, and cancelled checks are unverified and must not be treated as resolved findings.',
    ],
  }
}
