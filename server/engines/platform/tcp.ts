import { connect } from 'node:net'
import type { TcpProbeInput, TcpProbeResult } from './types'

/** Passive connect-only probe. It never writes application data. */
export function probeTcp(input: TcpProbeInput): Promise<TcpProbeResult> {
  if (input.signal.aborted)
    return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    let settled = false
    let connected = false
    const chunks: Buffer[] = []
    let bytes = 0
    const socket = connect({ host: input.address, port: input.port })

    const finish = (result: TcpProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(bannerWait)
      input.signal.removeEventListener('abort', abort)
      socket.destroy()
      resolve(result)
    }
    const abort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(bannerWait)
      input.signal.removeEventListener('abort', abort)
      socket.destroy()
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    let bannerWait: ReturnType<typeof setTimeout> | undefined
    const deadline = setTimeout(
      () => finish({ status: connected ? 'open' : 'unreachable', banner: Buffer.concat(chunks) }),
      input.timeoutMs,
    )

    socket.once('connect', () => {
      connected = true
      // A short, bounded passive wait captures greeting protocols without
      // turning a successful connect into a timeout-length operation.
      bannerWait = setTimeout(
        () => finish({ status: 'open', banner: Buffer.concat(chunks) }),
        Math.min(500, input.timeoutMs),
      )
    })
    socket.on('data', (chunk: Buffer) => {
      const take = Math.min(chunk.length, input.maxBytes - bytes)
      if (take > 0) {
        chunks.push(chunk.subarray(0, take))
        bytes += take
      }
      if (bytes >= input.maxBytes) finish({ status: 'open', banner: Buffer.concat(chunks) })
    })
    socket.once('end', () => {
      if (connected) finish({ status: 'open', banner: Buffer.concat(chunks) })
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        status: connected
          ? 'open'
          : error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET'
            ? 'closed'
            : 'unreachable',
      })
    })
    if (input.signal.aborted) abort()
    else input.signal.addEventListener('abort', abort, { once: true })
  })
}
