import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stampFor } from '@agnes/ai/testkit'
import { cacheDir, dataDir, type LockState } from '@agnes/host'
import type { TestHostOptions } from '@agnes/host/testkit'
import { createTestHost } from '@agnes/host/testkit'
import type { InferenceEvent, RequestBody } from '@agnes/protocol'
import type { LocalBootDeps } from '../src/boot/local.js'

/** One scripted turn: ScriptedProvider prepends `sent`, so an answer and a stop are all it needs. */
export const say = (text: string): InferenceEvent[] => [
  { type: 'text_delta', delta: text },
  { type: 'done', reason: 'stop' },
]

/**
 * The lockfile host has no reader for yet. The three ids are the ones templates/local-dev.yaml
 * declares; without an entry for each, resolveProfile refuses the whole profile.
 */
export const TEST_LOCK: LockState = {
  packages: Object.fromEntries(
    ['@agnes/ai', '@agnes/base', '@agnes/code'].map((id) => [
      id,
      { version: '0.1.0', integrity: 'sha512-fixture', trust: 'builtin' as const, enabled: true },
    ]),
  ),
}

/**
 * Boot dependencies pointed at a host that answers from a script. `dir` is both the home and the
 * workspace root, because the test host fences its sandbox at its dataDir and a session opened
 * outside that fence is refused with E_WORKSPACE_UNTRUSTED.
 */
/** Register a workspace on a real in-process endpoint before session/new. */
export async function ensureWorkspace(
  client: { workspace: { add(path: string): Promise<unknown> } },
  path: string,
): Promise<void> {
  await client.workspace.add(path)
}

export function testDeps(dir: string, over: Partial<LocalBootDeps> = {}): LocalBootDeps {
  return {
    env: {},
    home: dir,
    cwd: dir,
    agnesVersion: '0.0.0',
    log: () => undefined,
    lock: TEST_LOCK,
    createHostImpl: async () =>
      (await createTestHost({ dataDir: dir, script: [say('hello from the test host')] })).host,
    ...over,
  }
}

/**
 * A provider that pauses in the middle of a turn so a signal can land while one is running. The
 * pause is interrupted by the abort signal rather than merely outlived by it, so a cancelled run
 * ends at once instead of waiting the delay out, and an already-aborted signal is checked before the
 * wait because a listener added to a signal that has already fired never runs.
 */
export function slowProvider(
  delayMs: number,
  onStart: () => void = () => undefined,
): NonNullable<TestHostOptions['provider']> {
  return {
    models: () => [],
    async *infer(req: RequestBody, opts: { signal: AbortSignal; toolNames: string[] }) {
      onStart()
      yield {
        type: 'sent',
        stamp: stampFor(req),
      }
      if (!opts.signal.aborted)
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
      if (opts.signal.aborted) {
        yield { type: 'error', reason: 'aborted', code: 'ABORTED', message: 'aborted', retryable: false }
        return
      }
      yield { type: 'text_delta', delta: 'too late' }
      yield { type: 'done', reason: 'stop' }
    },
  }
}

/**
 * A provider that announces the request and then never answers, for staging the ledger a process
 * killed mid-inference leaves behind: the `step/start`, the `effect/intent` and the header are on
 * disk and nothing ever settles them. The abort is deliberately ignored - a process that is killed
 * does not get to write an `aborted` on its way out.
 */
export function stalledProvider(): NonNullable<TestHostOptions['provider']> {
  return {
    models: () => [],
    async *infer(req: RequestBody) {
      yield {
        type: 'sent',
        stamp: stampFor(req),
      }
      await new Promise<void>(() => undefined)
    },
  }
}

/**
 * A user profile that puts this installation's data inside the scratch directory.
 *
 * The builtin template no longer sets dataDir/cacheDir at all -- host's paths module now defaults
 * both under whatever home a test passes in -- but a test that boots for real still calls this so
 * its assertions do not depend on which home the resolver happened to be given, and so the intent
 * (this test's data lives in its own scratch directory, not wherever a default lands) stays
 * explicit rather than incidental.
 */
export function writeScratchProfile(dir: string): void {
  mkdirSync(join(dir, 'profiles', 'local-dev'), { recursive: true })
  writeFileSync(
    join(dir, 'profiles', 'local-dev', 'profile.yaml'),
    `name: local-dev\ndataDir: ${JSON.stringify(dataDir(dir))}\ncacheDir: ${JSON.stringify(cacheDir(dir))}\n`,
    'utf8',
  )
}
