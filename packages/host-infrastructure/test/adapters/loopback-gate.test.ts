import { lstatSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { dirname } from 'node:path'
import * as systemNode from '@agnes/system-node'
import { expect, it, vi } from 'vitest'
import { openLoopbackGate } from '../../src/adapters/loopback-gate.js'

it.runIf(process.platform === 'darwin').each(['symlink', 'socket', 'directory', 'missing'])(
  'refuses a gate whose %s was replaced before forwarding to an unrelated peer',
  async (replacement) => {
    let path = ''
    const open = systemNode.openUnixListener
    const observer = vi.spyOn(systemNode, 'openUnixListener').mockImplementation((value) => {
      path = value
      return open(value)
    })
    let gate: ReturnType<typeof openLoopbackGate>
    try {
      gate = openLoopbackGate()
    } finally {
      observer.mockRestore()
    }
    const directory = dirname(path)
    const moved = `${directory}-original`
    const peerPath = `${directory}/peer`
    let requests = 0
    let connections = 0
    const peer = createServer((_, response) => {
      requests++
      response.end('UNRELATED_PEER')
    })
    peer.on('connection', () => connections++)
    try {
      if (replacement === 'directory') {
        renameSync(directory, moved)
        symlinkSync(moved, directory)
      }
      const identity = lstatSync(path)
      unlinkSync(path)
      const target = replacement === 'socket' || replacement === 'directory' ? path : peerPath
      await new Promise<void>((resolve) => peer.listen(target, resolve))
      const control = await new Promise<string>((resolve, reject) => {
        get({ socketPath: target, path: '/' }, (response) => {
          let body = ''
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () => resolve(body))
        }).on('error', reject)
      })
      expect(control).toBe('UNRELATED_PEER')
      expect(connections).toBe(1)
      requests = connections = 0
      if (replacement === 'symlink') symlinkSync(peerPath, path)
      if (replacement === 'socket') expect(lstatSync(path).ino).not.toBe(identity.ino)
      await expect(
        fetch(gate.env.AGH_LOOPBACK_URL, {
          method: 'POST',
          body: 'private request',
          signal: AbortSignal.timeout(2000),
        }),
      ).rejects.toThrow()
      expect(requests).toBe(0)
      expect(connections).toBe(0)
    } finally {
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      gate.close()
      rmSync(moved, { recursive: true, force: true })
    }
  },
)
