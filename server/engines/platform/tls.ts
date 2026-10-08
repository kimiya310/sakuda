import { isIP } from 'node:net'
import { checkServerIdentity, connect, type PeerCertificate } from 'node:tls'
import type { TlsProbeInput, TlsProbeResult } from './types'

function safeText(value: unknown, maxLength: number): string {
  return [...String(value ?? '')]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
    .trim()
    .slice(0, maxLength)
}

function distinguishedName(value: object | undefined): string {
  if (!value) return ''
  return safeText(
    Object.entries(value)
      .map(([key, part]) => `${safeText(key, 32)}=${safeText(part, 128)}`)
      .join(', '),
    512,
  )
}

/** One TLS handshake only; this is certificate/config observation, not a cipher sweep. */
export function probeTls(input: TlsProbeInput): Promise<TlsProbeResult> {
  if (input.signal.aborted)
    return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = connect({
      host: input.address,
      port: input.port,
      servername: isIP(input.host) === 0 ? input.host : undefined,
      rejectUnauthorized: false,
    })
    const finish = (error?: Error, result?: TlsProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      input.signal.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = (): void => finish(new Error('aborted'))
    const deadline = setTimeout(() => finish(new Error('TLS probe timed out')), input.timeoutMs)
    socket.once('secureConnect', () => {
      try {
        const certificate = socket.getPeerCertificate() as PeerCertificate
        const protocol = safeText(socket.getProtocol(), 256)
        const cipher = safeText(socket.getCipher().name, 256)
        if (!certificate?.valid_to || !certificate.valid_from || !protocol || !cipher)
          return finish(new Error('TLS peer did not provide analyzable parameters'))
        const validTo = new Date(certificate.valid_to)
        const validFrom = new Date(certificate.valid_from)
        if (Number.isNaN(validTo.getTime()) || Number.isNaN(validFrom.getTime()))
          return finish(new Error('TLS peer provided invalid certificate dates'))
        // IP targets do not get SNI, but their iPAddress SAN still has to match.
        const identityError = checkServerIdentity(input.host, certificate)
        const now = Date.now()
        finish(undefined, {
          protocol,
          cipher,
          subject: distinguishedName(certificate.subject),
          issuer: distinguishedName(certificate.issuer),
          validTo: validTo.toISOString(),
          authorized: socket.authorized,
          expired: validTo.getTime() < now,
          notYetValid: validFrom.getTime() > now,
          hostnameMismatch: Boolean(identityError),
        })
      } catch {
        finish(new Error('TLS peer parameters could not be analyzed'))
      }
    })
    socket.once('error', (error) => finish(error))
    if (input.signal.aborted) abort()
    else input.signal.addEventListener('abort', abort, { once: true })
  })
}
