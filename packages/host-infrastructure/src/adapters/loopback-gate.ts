import { type BigIntStats, closeSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { LOOPBACK_GATE_PATH_PREFIX, openLoopbackListener, openUnixListener } from '@agnes/system-node'

/** The public TCP socket never crosses the sandbox boundary, even through dup/fork/setsid. */
export function openLoopbackGate() {
  const directory = mkdtempSync(LOOPBACK_GATE_PATH_PREFIX)
  const path = join(directory, 's')
  const connections = new Set<Socket>()
  let fd: number | undefined
  let tcpFd: number | undefined
  let closed = false
  let identities: BigIntStats[] = []
  const paths = [directory, path]
  const intact = () => {
    try {
      return paths.every((value, index) => {
        const current = lstatSync(value, { bigint: true })
        const original = identities[index]
        return original !== undefined && current.dev === original.dev && current.ino === original.ino
      })
    } catch {
      return false
    }
  }
  const server = createServer({ allowHalfOpen: true }, (incoming) => {
    if (closed || !intact()) {
      incoming.destroy()
      return
    }
    const upstream = createConnection({ path, allowHalfOpen: true })
    for (const socket of [incoming, upstream]) {
      connections.add(socket)
      socket.on('error', () => {
        incoming.destroy()
        upstream.destroy()
      })
      socket.once('close', () => {
        connections.delete(socket)
      })
    }
    upstream.once('connect', () => {
      // Seatbelt prevents sandbox path mutation. Also fail closed on a replaced/missing
      // transport, without releasing buffered request or response bytes before validation.
      if (closed || incoming.destroyed || !intact()) {
        incoming.destroy()
        upstream.destroy()
        return
      }
      incoming.pipe(upstream).pipe(incoming)
    })
  })
  const close = () => {
    if (closed) return
    closed = true
    server.close()
    for (const socket of connections) socket.destroy()
    connections.clear()
    try {
      if (tcpFd !== undefined) closeSync(tcpFd)
      if (fd !== undefined) closeSync(fd)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  server.on('error', close)
  try {
    fd = openUnixListener(path)
    identities = paths.map((value) => lstatSync(value, { bigint: true }))
    const listener = openLoopbackListener()
    tcpFd = listener.fd
    server.listen({ fd: tcpFd })
    // net.Server owns the public fd from here; it is never inherited by the child.
    tcpFd = undefined
    return {
      fd,
      env: { AGH_LOOPBACK_FD: '4', AGH_LOOPBACK_URL: `http://127.0.0.1:${listener.port}/` },
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}
