import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { Host } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { InferenceEvent } from '@agnes/protocol'
import type { SessionCommandFrame, SessionOpenFrame } from '../src/frames.js'
import { HostedSessions } from '../src/hosted-sessions.js'
import { SharedSessionChannel } from '../src/shared-session-channel.js'

type Frame = { kind: string; sessionKey?: string; seq?: number; reason?: string }

/**
 * HostedSessions over a real Host and SQLite ledger. Model calls can be held open with `hold()`, so a
 * turn stays in progress for as long as a test needs it to.
 */
export async function realHosted(
  o: {
    limits?: Record<string, number>
    wrapHost?: (host: Host) => Host
    idleCloseMs?: number
    clock?: () => number
  } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-hosted-real-'))
  const root = realpathSync(dataDir)
  let gate: Promise<void> = Promise.resolve()
  const inner = new ScriptedProvider({
    scripts: [[{ type: 'text_delta', delta: 'ok' } as InferenceEvent, { type: 'done', reason: 'stop' }]],
  })
  const provider = {
    models: () => inner.models(),
    async *infer(
      req: Parameters<ScriptedProvider['infer']>[0],
      opts: Parameters<ScriptedProvider['infer']>[1],
    ) {
      await gate
      yield* inner.infer(req, opts)
    },
  }
  const built = await createTestHost({
    dataDir,
    provider,
    disableSessionTitle: true,
    ...(o.limits ? { limits: o.limits } : {}),
  })
  const host = o.wrapHost ? o.wrapHost(built.host) : built.host
  const sent: Frame[] = []
  const channel = new SharedSessionChannel(() => undefined)
  const hosted = new HostedSessions({
    host,
    channel,
    send: (frame) => void sent.push(frame as Frame),
    workerGeneration: 1,
    workspaceRoot: root,
    ...(o.idleCloseMs !== undefined ? { idleCloseMs: o.idleCloseMs } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
  })
  const binding = (sessionKey: string) => ({
    version: 1,
    sessionKey,
    workspaceId: 'a'.repeat(64),
    revision: 1,
    canonicalRoot: root,
  })
  const openFrame = (sessionKey: string, params: Record<string, unknown> = {}): SessionOpenFrame => ({
    kind: 'session.open',
    requestId: `open:${sessionKey}`,
    sessionKey,
    params: { binding: binding(sessionKey), ...params } as SessionOpenFrame['params'],
  })
  let n = 0
  const command = (
    sessionKey: string,
    method: SessionCommandFrame['method'],
    params: Record<string, unknown> = {},
  ): SessionCommandFrame => ({
    kind: 'command',
    requestId: `${sessionKey}:${method}:${++n}`,
    sessionKey,
    method,
    params,
  })
  const hold = () => {
    let release!: () => void
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return () => {
      release()
      gate = Promise.resolve()
    }
  }
  const prompt = async (sessionKey: string, text: string) => {
    const session = built.host.kernel.get(sessionKey)
    if (!session) throw new Error(`${sessionKey} is not open`)
    await hosted.dispatch(
      command(sessionKey, 'enqueue', {
        target: 'next-turn',
        msg: { kind: 'prompt', actor: session.d.actor, content: [{ type: 'text', text }] },
      }),
    )
  }
  const run = (sessionKey: string) =>
    hosted.dispatch(command(sessionKey, 'run', { runId: `run:${++n}`, until: 'turn-end' }))
  const close = async () => {
    await hosted.closeAll()
    await built.host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
  return {
    host: built.host,
    hosted,
    channel,
    sent,
    root,
    binding,
    openFrame,
    command,
    hold,
    prompt,
    run,
    close,
  }
}
