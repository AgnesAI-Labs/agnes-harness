import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { detectBackend } from '@agnes/base/sandbox'
import { compileWorkspacePolicy, dataDir } from '@agnes/host'
import type { NodeClient } from '@agnes/sdk'
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
) {
  const home = await realpath(dirname(runtime.home))
  const plan = await compileWorkspacePolicy({
    canonicalRoot: await realpath(runtime.workspace),
    dataDir: dataDir(runtime.home),
    homeDir: home,
    semantics: { flavor: 'posix', caseSensitive: true },
    staticConfig: {
      level: 'L1',
      access: preset,
      required: false,
      onUnavailable: 'deny',
      extraPaths: [],
      denyPaths: [],
      networkAllow: [],
    },
    canonicalize: async (path, options) => {
      const target = resolve(options?.base ?? '/', path)
      try {
        return await realpath(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // Host may migrate the old data/secrets leaf; its real parent still fixes the identity.
        return join(await realpath(dirname(target)), basename(target))
      }
    },
  })
  const backend = await detectBackend({
    level: 'L1',
    shell: 'posix',
    options: plan.backendOptions,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    probeExec: async (argv, options) => {
      const [command, ...args] = argv
      if (!command) throw new Error('sandbox probe requires an executable')
      const result = await exec(command, args, {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: '/tmp', AGH_HOME: runtime.home },
      })
      return { ...result, code: 0, truncated: false, timedOut: false }
    },
  })
  await info.attach(`sandbox-${preset}.json`, {
    body: JSON.stringify({ backend: backend.name, enforcement: backend.enforcement }),
    contentType: 'application/json',
  })
  const opening = client.session.new({ cwd: runtime.workspace, preset, sessionKey: `wb1-terminal-${preset}` })
  if (backend.name !== 'none') return await opening
  await expect(opening).rejects.toMatchObject({
    code: -32011,
    rpc: { message: 'SEMANTIC_REJECTED' },
    data: { code: 'SANDBOX_UNAVAILABLE', messageKey: 'appServer.errors.unavailable' },
  })
  return undefined
}
