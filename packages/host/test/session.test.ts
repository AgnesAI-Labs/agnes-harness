import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stampFor } from '@agnes/ai/testkit'
import { testFsPolicy } from '@agnes/core/testkit'
import type { InferenceEvent, Provider } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecovery } from '../src/session.js'
import { createTestHost, startTurn } from '../testkit/index.js'

/**
 * A model that announces the request and then never answers. The ledger gets its `step/start`, its
 * `effect/intent` and its header, and the host is torn down with the call still outstanding - which
 * is the tail a SIGKILLed process leaves behind.
 */
const neverAnswers: Provider = {
  models: () => [],
  async *infer(req): AsyncIterable<InferenceEvent> {
    yield { type: 'sent', stamp: stampFor(req) }
    await new Promise<void>(() => undefined)
  },
}

/** Leaves a ledger under `dataDir` with a step nothing ever closed. */
async function killMidInference(dataDir: string): Promise<void> {
  const { host } = await createTestHost({ dataDir, provider: neverAnswers })
  const { session } = await startTurn(host, { prompt: 'say something', cwd: dataDir })
  // Wait for the durable condition this fixture needs. A fixed sleep raced module transforms and
  // parallel files, so close could win before the provider had written its dispatch receipt and
  // leave a clean ledger that correctly required no recovery.
  await vi.waitFor(async () => {
    expect(await session.scan({ type: 'request/sent', limit: 1 })).toHaveLength(1)
  })
  // Seal and release the durable log before Host sends its orderly abort. Host shutdown has become
  // intentionally better at draining live workspace work, so using it alone to emulate SIGKILL is
  // a scheduler race: the run can persist ABORTED before the log closes. A process crash loses that
  // chance. Closing the log first preserves the exact damaged tail while still letting Host clean
  // up its remaining test resources below.
  await session.d.log.close()
  await host.close()
}

type Refusal = { code: string; message: string; detail: Record<string, unknown> }
const refusal = async (p: Promise<unknown>): Promise<Refusal> =>
  p.then(
    () => {
      throw new Error('expected a refusal')
    },
    (e: unknown) => e as Refusal,
  )

describe('createSession', () => {
  const dirs: string[] = []
  const tmp = (prefix = 'agnes-sess-'): string => {
    const d = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('opens a session with the default preset and a host-minted actor', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir })
    const s = await host.createSession({ cwd: dataDir })
    expect(s.key).toMatch(/^agnes:local:local-dev:cli:workspace:[0-9a-f]{16}$/)
    const start = (await s.scan({ type: 'session/start', limit: 1 }))[0]
    // `preset` is the recipe name - the shape session-v1.json requires and core already writes.
    expect(start?.data).toMatchObject({ preset: 'standard', resolvedProfileHash: host.profile.hash })
    expect(start?.actor).toMatchObject({ role: 'owner', org: 'local' })
    await host.close()
  })
  // The view the session runs on must not carry the sentinel: core's resolveModel reads
  // preset.model.route[slot], and a view still saying `default` writes a request/header naming a
  // route no adapter serves.
  it('the session runs on a preset whose route and model are resolved, not the sentinel', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir })
    const s = await host.createSession({ cwd: dataDir })
    expect(s.preset.model.route).toEqual({ primary: 'gw' })
    expect(s.preset.model.id).toEqual({ primary: 'm1' })
    await host.close()
  })
  // core's SessionOptions requires writerRunId and nothing upstream mints one; that is host's.
  it('mints a writerRunId when the caller brings none, and keeps the caller\u2019s when it does', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir })
    const a = await host.createSession({ cwd: dataDir })
    expect(a.writerRunId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    await host.close()
    const other = tmp()
    const second = await createTestHost({ dataDir: other })
    const b = await second.host.createSession({ cwd: other, writerRunId: 'run-7' })
    expect(b.writerRunId).toBe('run-7')
    await second.host.close()
  })
  it('rejects a preset outside presets.allowed', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir })
    const e = await refusal(host.createSession({ cwd: dataDir, preset: 'nope' }))
    expect(e.code).toBe('E_PRESET_UNSUPPORTED')
    expect(e.detail.capability).toBe('preset')
    await host.close()
  })
  it('rejects hard requirements this deployment cannot meet, naming the capability', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({
      dataDir,
      presets: {
        l1: { name: 'l1', extends: 'standard', sandbox: { required: true } },
        py: {
          name: 'py',
          extends: 'standard',
          disclosure: 'code',
          code_runtime: { language: 'python', state: 'persistent' },
        },
      },
      allowed: ['standard', 'l1', 'py'],
      platformCaps: { 'sandbox.l1': 'unavailable' },
    })
    expect((await refusal(host.createSession({ cwd: dataDir, preset: 'l1' }))).detail.capability).toBe(
      'sandbox.l1',
    )
    expect((await refusal(host.createSession({ cwd: dataDir, preset: 'py' }))).detail.capability).toBe(
      'code_runtime.python',
    )
    await host.close()
  })
  it('accepts a preset requiring sandbox L1 when the platform provides it', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({
      dataDir,
      presets: { l1: { name: 'l1', extends: 'standard', sandbox: { required: true } } },
      allowed: ['standard', 'l1'],
    })
    const s = await host.createSession({ cwd: dataDir, preset: 'l1' })
    expect(s.key).toBeDefined()
    await host.close()
  })
  it('rejects a preset whose command_policy contains a rule that cannot decide', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({
      dataDir,
      presets: {
        loose: {
          name: 'loose',
          extends: 'standard',
          approval: { command_policy: [{ tool: 'edit', argv: 'src/', action: 'allow' }] },
        },
      },
      allowed: ['standard', 'loose'],
    })
    const e = await refusal(host.createSession({ cwd: dataDir, preset: 'loose' }))
    expect(e.detail.capability).toBe('approval.command_policy')
    await host.close()
  })
  // The vocabulary is the evaluator's; `ask` is this host's own former spelling of the middle
  // action, kept for one version so a deployment that already ships it still opens. It is not
  // silence: the audit is where the resolved profile is recorded and is what an operator reads to
  // see what this deployment decided, so the spelling that is going away is recorded beside it.
  it('opens on the deprecated ask spelling and records it on the audit', async () => {
    const dataDir = tmp()
    const { host, audit } = await createTestHost({
      dataDir,
      presets: {
        old: {
          name: 'old',
          extends: 'standard',
          approval: {
            command_policy: [
              { tool: 'shell', argv: '^curl ', action: 'ask' },
              { tool: 'edit', argv: '^/repo/', action: 'require_approval' },
            ],
          },
        },
      },
      allowed: ['standard', 'old'],
    })
    const s = await host.createSession({ cwd: dataDir, preset: 'old' })
    expect(s.key).toBeDefined()
    // One line for the deprecated rule, none for the one already written in the current words.
    expect(audit.events.filter((e) => e.kind === 'preset.deprecated').map((e) => e.detail)).toEqual([
      {
        capability: 'approval.command_policy',
        preset: 'old',
        tool: 'shell',
        action: 'ask',
        use: 'require_approval',
      },
    ])
    await host.close()
  })
  it('refuses a preset whose command_policy names an action the evaluator does not know', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({
      dataDir,
      presets: {
        odd: {
          name: 'odd',
          extends: 'standard',
          approval: { command_policy: [{ tool: 'shell', argv: '^curl ', action: 'prompt' }] },
        },
      },
      allowed: ['standard', 'odd'],
    })
    const e = await refusal(host.createSession({ cwd: dataDir, preset: 'odd' }))
    expect(e.code).toBe('E_PRESET_UNSUPPORTED')
    expect(e.detail.errors).toContainEqual({ path: '/approval/command_policy/0/action', code: 'ENUM' })
    await host.close()
  })
  it('refuses a cwd outside the assembled workspace root', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir })
    const e = await refusal(host.createSession({ cwd: tmp('agnes-elsewhere-') }))
    expect(e.detail.reason).toBe('cwd-outside-workspace')
    // The code is carried, not spelled out inside an E_SEAM_INIT message where no filter sees it.
    expect(e.code).toBe('E_WORKSPACE_UNTRUSTED')
    expect(e.message).not.toContain('E_FS_DENIED')
    await host.close()
  })
  it('fits a package sandbox template to the Host workspace instead of trusting its raw root', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({
      dataDir,
      seams: { sandbox: { fsPolicy: () => testFsPolicy('/w') } },
    })
    const session = await host.createSession({ cwd: dataDir })
    expect(realpathSync(session.d.cwd)).toBe(realpathSync(dataDir))
    await host.close()
  })
  it('does not let a per-session sandbox override bypass the Host workspace runtime', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir })
    const e = await refusal(
      host.createSession({
        cwd: dataDir,
        seams: {
          sandbox: {
            forWorkspace: async () => {
              throw new Error('unused')
            },
            exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
            confine: async (a) => a,
            fsPolicy: () => testFsPolicy('/elsewhere'),
            enforcement: () => ({ level: 'none', scope: [] }),
          },
        },
      }),
    )
    expect(e.code).toBe('E_SEAM_IMMUTABLE')
    expect(e.detail.seam).toBe('sandbox')
    await host.close()
  })
  // Opening a session is the only thing that asks the kernel to put right what a dead process left
  // in flight. Nothing else does: `resume()` had no caller outside tests, so `agnes resume <id>`
  // replayed a transcript and then threw `step already open` on the next turn.
  it('recovers a ledger a dead process left open, and tells the caller it did', async () => {
    const dataDir = tmp()
    await killMidInference(dataDir)
    const seen: SessionRecovery[] = []
    const { host, audit } = await createTestHost({ dataDir })
    const s = await host.createSession({
      cwd: dataDir,
      onRecovered: (r) => {
        seen.push(r)
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.state).toBe('resumed')
    expect(seen[0]?.actions.map((a) => a.action)).toEqual(['retry'])
    expect(audit.events.filter((e) => e.kind === 'session.recovered')).toHaveLength(1)
    expect(audit.events.find((e) => e.kind === 'session.recovered')?.detail).toMatchObject({
      sessionKey: s.key,
      actions: ['retry'],
    })
    // The step the dead process opened is closed, which is the whole point: the next turn on this
    // ledger no longer runs into it.
    const opened = await s.scan({ fromSeq: 1, toSeq: s.lastSeq as never, type: 'step/start' })
    const closed = await s.scan({ fromSeq: 1, toSeq: s.lastSeq as never, type: 'step/end' })
    expect(closed.length).toBe(opened.length)
    await host.close()
  })
  // The other side of the same wiring, and the one that has to hold for nearly every open there
  // will ever be: a ledger that ended cleanly is opened exactly as it was before recovery existed.
  it('appends nothing and reports nothing when the session needed no recovery', async () => {
    const dataDir = tmp()
    const first = await createTestHost({ dataDir, script: [[{ type: 'text_delta', delta: 'hi' }]] })
    const a = await first.host.createSession({ cwd: dataDir })
    await a.enqueue('next-turn', {
      content: [{ type: 'text', text: 'hello' }],
      actor: a.d.actor,
      kind: 'prompt',
    })
    await a.run({ until: 'turn-end', signal: new AbortController().signal })
    const sealedAt = a.lastSeq as number
    await first.host.close()

    const seen: SessionRecovery[] = []
    const { host, audit } = await createTestHost({ dataDir })
    const b = await host.createSession({
      cwd: dataDir,
      onRecovered: (r) => {
        seen.push(r)
      },
    })
    expect(seen).toEqual([])
    expect(audit.events.filter((e) => e.kind === 'session.recovered')).toEqual([])
    expect((b.lastSeq as number) - sealedAt).toBe(0)
    await host.close()
  })
  // Recovery writes, so it needs the writer lease - and it runs at the moment a second process may
  // be opening the same session. It inherits the lease's own answer rather than adding a second:
  // the lease is taken inside the kernel's open, above this, so the second process is refused there
  // and never reaches the recovery at all. One recovery, by whoever holds the lease.
  it('two processes opening one damaged session: the second is refused before it can recover', async () => {
    const dataDir = tmp()
    await killMidInference(dataDir)
    const winner = await createTestHost({ dataDir })
    const loser = await createTestHost({ dataDir })
    const seen: SessionRecovery[] = []
    const [a, b] = await Promise.allSettled([
      winner.host.createSession({
        cwd: dataDir,
        onRecovered: (r) => {
          seen.push(r)
        },
      }),
      loser.host.createSession({
        cwd: dataDir,
        onRecovered: (r) => {
          seen.push(r)
        },
      }),
    ])
    const outcomes = [a, b].map((r) => r.status)
    expect(outcomes.filter((x) => x === 'fulfilled')).toHaveLength(1)
    const failed = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((failed.reason as { code?: string }).code).toBe('E_WRITER_LEASE')
    expect(seen).toHaveLength(1)
    await winner.host.close()
    await loser.host.close()
  })
  // The in-process half of the same question, and the reason recovery needs no guard of its own for
  // it. Every createSession passes the fenced sandbox as a per-session seam, and the kernel refuses
  // to refit seams onto a session it already holds - so a second open of a live session is refused
  // outright and can never run a second recovery underneath a turn already in flight on it. Pinned
  // here because the day that refusal stops holding is the day recovery needs a guard.
  it('refuses a second open of a session this process already holds, so recovery cannot run twice', async () => {
    const dataDir = tmp()
    await killMidInference(dataDir)
    const seen: SessionRecovery[] = []
    const { host } = await createTestHost({ dataDir })
    const record = (r: SessionRecovery): void => {
      seen.push(r)
    }
    await host.createSession({ cwd: dataDir, writerRunId: 'run-1', onRecovered: record })
    const e = await refusal(host.createSession({ cwd: dataDir, writerRunId: 'run-1', onRecovered: record }))
    expect(e.code).toBe('E_LANE_BUSY')
    expect(seen).toHaveLength(1)
    await host.close()
  })
  it('refuses a ledger override and accepts another per-session seam', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir })
    const e = await refusal(
      host.createSession({ cwd: dataDir, seams: { ledger: {} } as unknown as Record<string, never> }),
    )
    expect(e.code).toBe('E_SEAM_IMMUTABLE')
    expect(e.detail.seam).toBe('ledger')
    const s = await host.createSession({
      cwd: dataDir,
      seams: { approval: { ask: async () => 'rejected', resume: async () => null } },
    })
    expect(s.key).toBeDefined()
    await host.close()
  })
})
