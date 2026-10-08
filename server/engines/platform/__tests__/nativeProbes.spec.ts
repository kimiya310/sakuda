import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { netConnect, tlsConnect } = vi.hoisted(() => ({ netConnect: vi.fn(), tlsConnect: vi.fn() }))
vi.mock('node:net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:net')>()),
  connect: netConnect,
}))
vi.mock('node:tls', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tls')>()),
  connect: tlsConnect,
}))

// Mock setup must precede the modules under test.
// eslint-disable-next-line import/first
import { probeTcp } from '../tcp'
// eslint-disable-next-line import/first
import { probeTls } from '../tls'

describe('native probe abort guards', () => {
  it('does not create a TCP socket when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      probeTcp({
        address: '192.0.2.1',
        port: 22,
        timeoutMs: 1000,
        maxBytes: 512,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(netConnect).not.toHaveBeenCalled()
  })

  it('does not create a TLS socket when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      probeTls({
        address: '192.0.2.1',
        host: 'host.example.test',
        port: 443,
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(tlsConnect).not.toHaveBeenCalled()
  })

  it('caps a passive banner and completes when the peer ends', async () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    netConnect.mockImplementationOnce(() => {
      queueMicrotask(() => {
        socket.emit('connect')
        socket.emit('data', Buffer.alloc(700, 65))
        socket.emit('end')
      })
      return socket
    })
    const result = await probeTcp({
      address: '192.0.2.1',
      port: 22,
      timeoutMs: 1000,
      maxBytes: 512,
      signal: new AbortController().signal,
    })
    expect(result.status).toBe('open')
    expect(result.banner).toHaveLength(512)
    expect(socket.destroy).toHaveBeenCalled()
  })

  it('rejects an invalid certificate date inside the TLS event handler', async () => {
    const socket = Object.assign(new EventEmitter(), {
      authorized: false,
      destroy: vi.fn(),
      getPeerCertificate: () => ({
        valid_from: 'not-a-date',
        valid_to: 'also-not-a-date',
        subject: { CN: 'bad\nname' },
        issuer: { CN: 'issuer' },
      }),
      getProtocol: () => 'TLSv1.2',
      getCipher: () => ({ name: 'AES128-GCM-SHA256' }),
    })
    tlsConnect.mockImplementationOnce(() => {
      queueMicrotask(() => socket.emit('secureConnect'))
      return socket
    })
    await expect(
      probeTls({
        address: '192.0.2.1',
        host: 'host.example.test',
        port: 443,
        timeoutMs: 1000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('invalid certificate dates')
    expect(socket.destroy).toHaveBeenCalled()
  })
})

describe('TCP reachability evidence', () => {
  it('keeps a successfully connected port open even if the peer resets it', async () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    netConnect.mockImplementationOnce(() => {
      queueMicrotask(() => {
        socket.emit('connect')
        socket.emit('error', Object.assign(new Error('fixture reset'), { code: 'ECONNRESET' }))
      })
      return socket
    })
    const result = await probeTcp({
      address: '192.0.2.1',
      port: 22,
      timeoutMs: 1000,
      maxBytes: 512,
      signal: new AbortController().signal,
    })
    expect(result.status).toBe('open')
    expect(socket.destroy).toHaveBeenCalled()
  })
})
