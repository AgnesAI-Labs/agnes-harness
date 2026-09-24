import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { type Host, resolveWorkspaceDirectory } from '@agnes/host'
import { createTestHost, type TestHostOptions } from '@agnes/host/testkit'
import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import {
  createLocalEndpoint,
  type LocalEndpointOptions,
  MemoryWorkspaceStore,
  WorkspaceCatalog,
} from '../src/local/index.js'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'

/** One scripted turn that answers with `text` and stops. ScriptedProvider prepends `sent` itself. */
export function say(text: string): InferenceEvent[] {
  return [
    { type: 'text_delta', delta: text },
    { type: 'done', reason: 'stop' },
  ]
}

/**
 * A provider that pauses between events so a cancel can land mid-turn. The pause is interrupted by
 * the abort signal rather than merely outlived by it, so an aborted run finishes at once instead of
 * waiting out the delay. An already-aborted signal is checked before the wait rather than only
 * listened to: adding a listener to a signal that has already fired never runs it, so a run aborted
 * before it reached the pause would have sat out the full delay anyway.
 */
export function slowProvider(delayMs: number): Provider {
  const inner = new ScriptedProvider({
    scripts: [
      [
        { type: 'text_delta', delta: 'never' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  return {
    models: () => inner.models(),
    async *infer(req: RequestBody, opts: { signal: AbortSignal; toolNames: string[] }) {
      for await (const e of inner.infer(req, opts)) {
        yield e
        if (opts.signal.aborted) continue
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(() => {
            opts.signal.removeEventListener('abort', onAbort)
            resolve()
          }, delayMs)
          opts.signal.addEventListener('abort', onAbort, { once: true })
        })
      }
    },
  }
}

/** A real explicit workspace authority for endpoint tests that assemble their own Host. */
export async function testWorkspaceCatalog(...paths: string[]): Promise<WorkspaceCatalog> {
  return testWorkspaceCatalogAt(() => Date.now(), ...paths)
}

export async function testWorkspaceCatalogAt(
  clock: () => number,
  ...paths: string[]
): Promise<WorkspaceCatalog> {
  const workspaces = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    resolveWorkspaceDirectory,
    clock,
  )
  for (const path of paths) await workspaces.add(path)
  return workspaces
}

export async function openTestHost(
  o: Pick<TestHostOptions, 'allowed' | 'approval' | 'presets' | 'provider' | 'script' | 'seams'> = {},
): Promise<{
  host: Host
  dataDir: string
  workspaces: WorkspaceCatalog
  endpoint(options?: LocalEndpointOptions): ReturnType<typeof createLocalEndpoint>
  addWorkspace(path: string): Promise<void>
  close(): Promise<void>
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnesd-'))
  const { host } = await createTestHost({
    dataDir,
    script: o.script ?? [say('hello')],
    ...(o.provider ? { provider: o.provider } : {}),
    ...(o.approval ? { approval: o.approval } : {}),
    ...(o.presets ? { presets: o.presets } : {}),
    ...(o.allowed ? { allowed: o.allowed } : {}),
    ...(o.seams ? { seams: o.seams } : {}),
  })
  const workspaces = await testWorkspaceCatalog(dataDir)
  return {
    host,
    dataDir,
    workspaces,
    endpoint(options = {}) {
      return createLocalEndpoint(host, {
        ...options,
        workspaces: options.workspaces ?? workspaces,
      })
    },
    async addWorkspace(path) {
      await workspaces.add(path)
    },
    async close() {
      await host.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
