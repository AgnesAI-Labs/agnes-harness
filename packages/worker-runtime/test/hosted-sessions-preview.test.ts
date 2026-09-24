import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { Host } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { HostedSessions } from '../src/hosted-sessions.js'
import { SharedSessionChannel } from '../src/shared-session-channel.js'
import { realHosted } from './real-hosted.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type PreviewFrame = {
  kind: 'preview'
  sessionKey: string
  lane: string
  effectId: string
  stream: string
  offset: number
  delta: string
}

describe('HostedSessions forwards streamed text as preview frames', () => {
  it('sends each streamed delta of a tailed session as a seq-less preview frame', async () => {
    const t = await realHosted()
    cleanups.push(t.close)
    await t.hosted.open(t.openFrame('live'))
    await t.hosted.tail('live', 1)
    await t.prompt('live', 'hi')
    await t.run('live')
    const previews = t.sent.filter((f) => f.kind === 'preview') as unknown as PreviewFrame[]
    expect(previews.length).toBeGreaterThan(0)
    expect(previews[0]).toMatchObject({
      sessionKey: 'live',
      lane: 'main',
      stream: 'text',
      offset: 0,
      delta: 'ok',
    })
    expect(previews[0]).not.toHaveProperty('seq')
    expect(typeof previews[0]?.effectId).toBe('string')
  })

  it('sends nothing for a session nobody tails', async () => {
    const t = await realHosted()
    cleanups.push(t.close)
    await t.hosted.open(t.openFrame('untailed'))
    await t.prompt('untailed', 'hi')
    await t.run('untailed')
    expect(t.sent.some((f) => f.kind === 'preview')).toBe(false)
  })

  it('answers a snapshot with nothing between inferences', async () => {
    const t = await realHosted()
    cleanups.push(t.close)
    await t.hosted.open(t.openFrame('idle'))
    await expect(t.hosted.dispatch(t.command('idle', 'previewSnapshot'))).resolves.toEqual([])
  })

  it('answers a snapshot for a hibernated session without waking it', async () => {
    let now = Date.UTC(2026, 0, 1)
    let creates = 0
    const t = await realHosted({
      idleCloseMs: 60_000,
      clock: () => now,
      wrapHost: (host) =>
        ({
          ...host,
          createSession: async (o: Parameters<Host['createSession']>[0]) => {
            creates++
            return host.createSession(o)
          },
        }) as Host,
    })
    cleanups.push(t.close)
    await t.hosted.open(t.openFrame('stub'))
    now += 60_000
    await t.hosted.sweep()
    expect(t.host.kernel.get('stub')).toBeUndefined()
    const created = creates
    await expect(t.hosted.dispatch(t.command('stub', 'previewSnapshot'))).resolves.toEqual([])
    expect(creates).toBe(created)
    expect(t.host.kernel.get('stub')).toBeUndefined()
  })
})

describe('a worker shutting down mid-stream keeps what was streamed', () => {
  it('records the text once, so the next process shows it and bills it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-hosted-cut-'))
    const root = realpathSync(dataDir)
    const inner = new ScriptedProvider({
      scripts: [
        [
          { type: 'text_delta', delta: 'partial text' },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    let streamed!: () => void
    const reached = new Promise<void>((resolve) => {
      streamed = resolve
    })
    const provider = {
      models: () => inner.models(),
      async *infer(req: Parameters<typeof inner.infer>[0], opts: Parameters<typeof inner.infer>[1]) {
        for await (const event of inner.infer(req, opts)) {
          if (event.type === 'done') {
            streamed()
            await new Promise<void>((resolve) =>
              opts.signal.addEventListener('abort', () => resolve(), { once: true }),
            )
            throw new Error('stream cut')
          }
          yield event
        }
      },
    }
    const built = await createTestHost({ dataDir, provider, disableSessionTitle: true })
    const hosted = new HostedSessions({
      host: built.host,
      channel: new SharedSessionChannel(() => undefined),
      send: () => undefined,
      workerGeneration: 1,
      workspaceRoot: root,
    })
    const binding = {
      version: 1,
      sessionKey: 'cut',
      workspaceId: 'a'.repeat(64),
      revision: 1,
      canonicalRoot: root,
    }
    try {
      await hosted.open({
        kind: 'session.open',
        requestId: 'o',
        sessionKey: 'cut',
        params: { binding },
      } as never)
      const session = built.host.kernel.get('cut')
      if (!session) throw new Error('session did not open')
      await hosted.dispatch({
        kind: 'command',
        requestId: 'e',
        sessionKey: 'cut',
        method: 'enqueue',
        params: {
          target: 'next-turn',
          msg: { kind: 'prompt', actor: session.d.actor, content: [{ type: 'text', text: 'go' }] },
        },
      })
      const running = hosted
        .dispatch({
          kind: 'command',
          requestId: 'r',
          sessionKey: 'cut',
          method: 'run',
          params: { runId: 'r1' },
        })
        .catch(() => undefined)
      await reached
      // What the worker does when its daemon link closes: close every hosted session.
      await hosted.closeAll()
      await running
      const reopened = await built.host.createSession({ key: 'cut', cwd: root })
      const rows = (await reopened.scan({ type: 'assistant/output', limit: 10 })) as unknown as Array<{
        data: { state: string; content?: Array<{ type: string; text: string }>; estimatedTokens: number }
      }>
      const cut = rows.find((row) => row.data.state === 'interrupted')
      expect(cut?.data.content).toEqual([{ type: 'text', text: 'partial text' }])
      await reopened.resume()
      const [cost] = await reopened.scan({ type: 'cost/ledger', limit: 5 })
      expect(cost?.data).toMatchObject({ interrupted: true, tokens: { output: cut?.data.estimatedTokens } })
      await reopened.close()
    } finally {
      await hosted.closeAll().catch(() => undefined)
      await built.host.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
