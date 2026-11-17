import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxExecRequest } from '@agnes/extension-api'

/** One owned workspace proves that the daemon sees this client's actual bind source. */
export function workspaceRoundtrip(dir: string) {
  const nonce = randomUUID()
  writeFileSync(join(dir, 'input-marker'), nonce)
  const request: SandboxExecRequest = {
    argv: [
      'sh',
      '-c',
      'test "$(cat input-marker)" = "$1" && printf "%s" "$1" > output-marker && echo ok',
      'agh-bind-check',
      nonce,
    ],
    cwd: dir,
    fsWrite: [{ path: dir }],
    network: false,
    limits: { timeoutMs: 180_000 },
  }
  return { nonce, request, output: join(dir, 'output-marker') }
}
