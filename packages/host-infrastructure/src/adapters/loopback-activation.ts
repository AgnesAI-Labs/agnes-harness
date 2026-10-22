import { closeSync } from 'node:fs'
import {
  type SandboxEnforcement,
  type SandboxExecutionPolicy,
  sandboxUnavailable,
} from '@agnes/extension-api'
import { openLoopbackListener } from '@agnes/system-node'

/** Called after tool admission. No bind authority is transferred: only this already-listening fd. */
export function loopbackActivation(policy: SandboxExecutionPolicy, actual: SandboxEnforcement, os: string) {
  if (policy.network.mode !== 'loopback-serve') return undefined
  if (
    os !== 'darwin' ||
    actual.level !== 'full' ||
    !(['file', 'network', 'process'] as const).every((scope) => actual.scope.includes(scope))
  )
    throw sandboxUnavailable('loopback socket activation requires macOS L1 network enforcement')
  const listener = openLoopbackListener()
  let closed = false
  return {
    fd: listener.fd,
    env: { AGH_LOOPBACK_FD: '4', AGH_LOOPBACK_URL: `http://127.0.0.1:${listener.port}/` },
    close() {
      if (!closed) {
        closed = true
        closeSync(listener.fd)
      }
    },
  }
}
