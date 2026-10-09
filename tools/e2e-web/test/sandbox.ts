import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { NodeClient, Session } from '@agnes/sdk'
import type { TestInfo } from '@playwright/test'
import { expect } from '../fixtures.js'
import type { Runtime } from '../runtime.js'

const exec = promisify(execFile)

/** Probe the complete OS boundary independently of the RPC result, under the same isolated home. */
export async function sandboxedSession(
  client: NodeClient,
  runtime: Runtime,
  preset: 'read-only' | 'workspace-write',
  info: TestInfo,
): Promise<Session | undefined> {
  const result = await exec(
    process.execPath,
    ['--import', 'tsx', 'tools/e2e-web/test/sandbox-probe.mjs', runtime.home, runtime.workspace, preset],
    { timeout: 20_000, maxBuffer: 4096 },
  )
  const backend = JSON.parse(result.stdout)
  expect(['none', 'bwrap', 'seatbelt']).toContain(backend.backend)
  await info.attach(`sandbox-${preset}.json`, {
    body: result.stdout,
    contentType: 'application/json',
  })
  const opening = client.session.new({ cwd: runtime.workspace, preset, sessionKey: `wb1-terminal-${preset}` })
  if (backend.backend !== 'none') return await opening
  await expect(opening).rejects.toMatchObject({
    code: -32011,
    rpc: { message: 'SEMANTIC_REJECTED' },
    data: {
      code: 'E_SANDBOX_WORKSPACE',
      cause: { code: 'E_SANDBOX_WORKSPACE' },
      messageKey: 'appServer.errors.unavailable',
    },
  })
  return undefined
}
