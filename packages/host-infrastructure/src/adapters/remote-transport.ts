import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { type RemoteTransport, RemoteTransportClosed } from '@agnes/core'

export { type RemoteTransport, RemoteTransportClosed } from '@agnes/core'

/**
 * The test double for Stage A: it satisfies the contract without a network, running commands on this
 * machine under a scratch root. It is not a sandbox and claims to be none - assembly reports the
 * remote posture, and sandbox.l1 stays unattested (spec RA11).
 */
export function createLoopbackTransport(_opts: { root: string }): RemoteTransport {
  let open = true
  const guard = () => {
    if (!open) throw new RemoteTransportClosed()
  }
  return Object.freeze({
    alive: () => open,
    async close() {
      open = false
    },
    /**
     * Execute a command in this machine's scratch workspace. This loopback implementation is a
     * test double: it accepts `timeoutMs`, `signal`, and `maxOutputBytes` per the RemoteTransport
     * interface contract but does not enforce them — it always returns `truncated: false`
     * regardless of output size, ignores abort signals, and has no timeout mechanism. It exercises
     * the contract's shape only, not its bounded/cancellable execution semantics. Any real
     * implementation (SSH-based, vendor-specific) must honor these fields itself.
     */
    async exec(cmd, o) {
      guard()
      const [bin, ...args] = cmd
      if (bin === undefined) throw new Error('empty argv')
      return await new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
          cwd: o.cwd,
          ...(o.env ? { env: o.env } : {}),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c) => {
          stdout += String(c)
        })
        child.stderr.on('data', (c) => {
          stderr += String(c)
        })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr, truncated: false }))
        if (o.stdin !== undefined) child.stdin.end(o.stdin)
        else child.stdin.end()
      })
    },
    async upload(files) {
      guard()
      for (const f of files) {
        await mkdir(dirname(f.path), { recursive: true })
        await writeFile(f.path, f.content)
      }
    },
    async download(paths) {
      guard()
      const out: { path: string; content: Uint8Array }[] = []
      for (const p of paths) out.push({ path: p, content: new Uint8Array(await readFile(p)) })
      return out
    },
  })
}
