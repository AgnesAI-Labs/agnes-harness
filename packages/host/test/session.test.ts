import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { stampFor } from '@agnes/ai/testkit'
import { testFsPolicy } from '@agnes/core/testkit'
import type { ToolContext } from '@agnes/extension-api'
import { PINNED_SEAM_KINDS } from '@agnes/extension-api/seams'
import { createSqliteStorage } from '@agnes/host-infrastructure/adapters/storage-sqlite'
import { SessionSandboxStore } from '@agnes/host-providers/profile/sandbox-state'
import type { InferenceEvent, Provider } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecovery } from '../src/runtime/sessions/session.js'
import { createTestHost, startTurn } from '../testkit/index.js'

/**
 * A model that announces the request and then never answers. The ledger gets its `step/start`, its
 * `effect/intent` and its header, and the host is torn down with the call still outstanding - which
 * is the tail a SIGKILLed process leaves behind. The caller seals the ledger before abort so
 * this provider can honor cancellation during cleanup without repairing that damaged tail.
 */
const neverAnswers: Provider = {
  models: () => [],
  async *infer(req, { signal }): AsyncIterable<InferenceEvent> {
    yield { type: 'sent', stamp: stampFor(req) }
    if (!signal.aborted)
      await new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true }))
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
    expect(existsSync(join(dataDir, 'profiles'))).toBe(false)
    const { host } = await createTestHost({ dataDir })
    const s = await host.createSession({ cwd: dataDir })
    expect(s.key).toMatch(/^agnes:local:local-dev:cli:workspace:[0-9a-f]{16}$/)
    const start = (await s.scan({ type: 'session/start', limit: 1 }))[0]
    // `preset` is the recipe name - the shape session-v1.json requires and core already writes.
    expect(start?.data).toMatchObject({
      preset: 'standard',
      resolvedProfileHash: host.profile.hash,
      resolvedPresetHash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/),
    })
    expect((start?.data as { resolvedPresetHash?: string } | undefined)?.resolvedPresetHash).not.toBe(
      host.profile.hash,
    )
    expect(start?.actor).toMatchObject({ role: 'owner', org: 'local' })
    await host.close()
  })
  it('resumes pre-record history through the workspace runtime under full local L1 isolation', async () => {
    const dataDir = tmp()
    const boot = () =>
      createTestHost({
        dataDir,
        disableSessionTitle: true,
        script: [
          [
            { type: 'text_delta', delta: 'resumed reply' },
            { type: 'done', reason: 'stop' },
          ],
        ],
        packages: {
          '@agnes/base': {
            sandboxWorkspaceProbe: async () => ({
              name: 'seatbelt',
              implementation: 'implemented',
              probeState: 'ready',
              execBackend: 'l1',
              enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
              degraded: false,
              confine: ({ argv }) => argv,
            }),
          },
        },
      })
    const first = await boot()
    let key: string
    try {
      const session = await first.host.createSession({ cwd: dataDir })
      key = session.key
      expect(await session.scan({ type: 'session/start', limit: 1 })).toHaveLength(1)
    } finally {
      await first.host.close()
    }
    // Keep the durable workspace and generation pins, but simulate history predating execution records.
    new SessionSandboxStore(join(dataDir, 'profiles', 'local-dev')).release(key)
    const second = await boot()
    try {
      const session = await second.host.createSession({ key, cwd: dataDir })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'continue the old session' }],
        actor: session.d.actor,
      })
      expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
        reason: 'completed',
      })
      expect((await session.scan({ type: 'assistant/message', limit: 1 }))[0]?.data).toMatchObject({
        content: [{ type: 'text', text: 'resumed reply' }],
      })
    } finally {
      await second.host.close()
    }
    const third = await boot()
    try {
      await third.host.createSession({ key, cwd: dataDir })
    } finally {
      await third.host.close()
    }
  })
  // A workspace's case semantics are measured from the names in its root. An empty root gives no
  // signal, so the measurement must not change once the first open has put Host's own `.agh` there:
  // the execution record pins the policy digest, and a changed digest locks the session's history.
  it('reopens a session that began in an empty workspace', async () => {
    const dataDir = tmp()
    const root = realpathSync.native(tmp('agnes-empty-ws-'))
    const key = 'empty-workspace-session'
    const first = await createTestHost({ dataDir, workspaceRoot: root, disableSessionTitle: true })
    try {
      await first.host.createSession({ key, cwd: root })
    } finally {
      await first.host.close()
    }
    const second = await createTestHost({ dataDir, workspaceRoot: root, disableSessionTitle: true })
    try {
      await expect(second.host.createSession({ key, cwd: root })).resolves.toMatchObject({ key })
    } finally {
      await second.host.close()
    }
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
  it('hands each session the command table of its own preset, not the default preset’s', async () => {
    const dataDir = tmp()
    const rule = { tool: 'shell', argv: '^git push', action: 'deny' }
    const { host } = await createTestHost({
      dataDir,
      presets: { strict: { name: 'strict', extends: 'standard', approval: { command_policy: [rule] } } },
      allowed: ['standard', 'strict'],
    })
    const table = async (preset: string) =>
      host.kernel.get((await host.createSession({ key: preset, cwd: dataDir, preset })).key)?.preset.approval
        .commandTable
    expect(await table('strict')).toEqual([rule])
    expect((await table('standard')) ?? []).not.toContainEqual(rule)
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
  it('refuses the retired ask spelling as an action the evaluator does not know', async () => {
    const dataDir = tmp()
    const { host } = await createTestHost({
      dataDir,
      presets: {
        old: {
          name: 'old',
          extends: 'standard',
          approval: { command_policy: [{ tool: 'shell', argv: '^curl ', action: 'ask' }] },
        },
      },
      allowed: ['standard', 'old'],
    })
    await expect(host.createSession({ cwd: dataDir, preset: 'old' })).rejects.toThrow(/E_PRESET_UNSUPPORTED/)
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
    expect(e.code).toBe('E_WORKSPACE_UNTRUSTED')
    expect(e.message).toContain('cwd is not the configured local workspace')
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
    expect(realpathSync.native(session.d.cwd)).toBe(realpathSync.native(dataDir))
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
  it.each([false, true])(
    'refuses damaged history without changing evidence or replaying tools after a raw open=%s',
    async (rawOpenFirst) => {
      const dataDir = tmp()
      let executions = 0
      const first = await createTestHost({
        dataDir,
        script: [
          [
            {
              type: 'toolcall_end',
              call: { toolUseId: '', name: 'read', args: { path: 'pending.txt' }, ordinal: 0 },
              via: 'native',
            },
            { type: 'done', reason: 'toolUse' },
          ],
        ],
      })
      const session = await first.host.createSession({ cwd: dataDir })
      const tools = session.currentTools()
      tools.add(
        {
          name: 'read',
          description: 'A safe tool with an interrupted durable effect',
          parameters: Type.Object({ path: Type.String() }),
          meta: {
            isReadOnly: true,
            isDestructive: false,
            isConcurrencySafe: true,
            isOpenWorld: false,
            replay: 'safe',
            costHint: {},
            deferLoading: false,
            requiresApproval: 'never',
          },
          execute: async (_args: unknown, ctx: ToolContext) => {
            executions++
            if (!ctx.signal.aborted)
              await new Promise<void>((resolve) =>
                ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
              )
            return { content: [{ type: 'text', text: 'once' }] }
          },
        },
        { source: 'test/pending-read', trust: 'builtin' },
      )
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'run once' }],
        actor: session.d.actor,
      })
      const running = session
        .run({ until: 'turn-end', signal: new AbortController().signal })
        .catch(() => undefined)
      await vi.waitFor(() => expect(executions).toBe(1))
      await session.d.log.append([session.ev('x/test/torn-tail', { pending: true }, { ignorable: true })])
      const damagedSeq = session.lastSeq
      await session.d.log.close()
      await first.host.close()
      await running
      const db = new DatabaseSync(join(dataDir, 'sessions.db'))
      db.prepare('UPDATE events SET data = ? WHERE session_key = ? AND seq = ?').run(
        '{',
        session.key,
        damagedSeq,
      )
      const evidence = db.prepare('SELECT * FROM events WHERE session_key = ? ORDER BY seq').all(session.key)
      db.close()
      if (rawOpenFirst) {
        const storage = createSqliteStorage({ file: join(dataDir, 'sessions.db') })
        expect(
          (await storage.open(session.key, { writerRunId: 'raw-open', ttlMs: 60000 })).recovery,
        ).toBeUndefined()
        await storage.release(session.key, 'raw-open')
        await storage.close()
      }
      const reopened = await createTestHost({ dataDir })

      try {
        await expect(reopened.host.createSession({ cwd: dataDir })).rejects.toMatchObject({
          code: 'E_SESSION_CORRUPT',
        })
        expect(executions).toBe(1)
        expect(reopened.audit.events.filter((event) => event.kind === 'session.recovered')).toEqual([])
        const preserved = new DatabaseSync(join(dataDir, 'sessions.db'))
        try {
          expect(
            preserved.prepare('SELECT * FROM events WHERE session_key = ? ORDER BY seq').all(session.key),
          ).toEqual(evidence)
        } finally {
          preserved.close()
        }
      } finally {
        await reopened.host.close()
      }
    },
  )

  it('keeps an interrupted mutation unknown on cold reopen instead of replaying it as a current safe tool', async () => {
    const dataDir = tmp()
    const first = await createTestHost({
      dataDir,
      disableSessionTitle: true,
      script: [
        [
          {
            type: 'toolcall_end',
            call: { toolUseId: '', name: 'read', args: { path: 'effect.txt' }, ordinal: 0 },
            via: 'native',
          },
          { type: 'done', reason: 'toolUse' },
        ],
      ],
    })
    const session = await first.host.createSession({ cwd: dataDir })
    let effects = 0
    session.currentTools().add(
      {
        name: 'read',
        description: 'Synthetic mutation whose external receipt is lost',
        parameters: Type.Object({ path: Type.String() }),
        meta: {
          isReadOnly: false,
          isDestructive: true,
          isConcurrencySafe: false,
          isOpenWorld: false,
          replay: 'never',
          costHint: {},
          deferLoading: false,
          requiresApproval: 'never',
        },
        execute: async (_args: unknown, ctx: ToolContext) => {
          effects++
          if (!ctx.signal.aborted)
            await new Promise<void>((done) =>
              ctx.signal.addEventListener('abort', () => done(), { once: true }),
            )
          return { content: [{ type: 'text', text: 'lost receipt' }] }
        },
      },
      { source: 'test/interrupted-mutation', trust: 'builtin' },
    )
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'perform synthetic effect' }],
      actor: session.d.actor,
    })
    const running = session
      .run({ until: 'turn-end', signal: new AbortController().signal })
      .catch(() => undefined)
    await vi.waitFor(() => expect(effects).toBe(1))
    expect(await session.scan({ type: 'tool/result', limit: 10 })).toEqual([])
    // Seal before abort, preserving the durable tail a killed worker leaves.
    await session.d.log.close()
    await first.host.close()
    await running
    const reopened = await createTestHost({ dataDir, disableSessionTitle: true })
    try {
      const recovery: SessionRecovery[] = []
      const restored = await reopened.host.createSession({
        cwd: dataDir,
        onRecovered: (value) => recovery.push(value),
      })
      expect(recovery.flatMap((value) => value.actions.map((action) => action.action))).toContain('unknown')
      expect((await restored.scan({ type: 'tool/result', limit: 10 })).map((row) => row.data)).toContainEqual(
        expect.objectContaining({ code: 'TOOL_OUTCOME_UNKNOWN', isError: true }),
      )
      expect(effects).toBe(1)
      // A second opening consumes the settled recovery fact, not another dispatch.
      await restored.close()
      const again = await reopened.host.createSession({ cwd: dataDir })
      expect(await again.scan({ type: 'tool/result', limit: 10 })).toHaveLength(1)
      expect(effects).toBe(1)
    } finally {
      await reopened.host.close()
    }
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
  it.each(PINNED_SEAM_KINDS)('refuses a per-session %s object before opening', async (kind) => {
    const dataDir = tmp()
    const { host } = await createTestHost({ dataDir })
    const e = await refusal(
      host.createSession({ cwd: dataDir, seams: { [kind]: {} } as unknown as Record<string, never> }),
    )
    expect(e.code).toBe('E_SEAM_IMMUTABLE')
    expect(e.detail.seam).toBe(kind)
    await host.close()
  })
})
