import { createHash } from 'node:crypto'
import { createAttachmentStore, createExtensionActivationBarrier } from '@agnes/host'
import type { ContentBlock } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { type JobRow, JobsRepo } from '../src/jobs/repo.js'
import { Scheduler, type SchedulerRegistry } from '../src/jobs/scheduler.js'
import type { WorkspaceBindingEnvelope } from '../src/storage/workspaces.js'
import { openTestHost } from './host.js'
import { sqliteTables } from './sqlite-tables.js'

// Every way user content reaches a session's queue: ACP prompt, steer, follow-up and a scheduled job.
// A reference to bytes this session was never given is refused before anything is appended; one it
// holds an upload receipt for is queued as sent.

const CLIENT = 'attach-entry'
const init = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      _meta: { 'ai.agnes.harness': { capabilities: { permission: false, attachmentRefs: 1 } } },
    },
    _meta: { 'ai.agnes.harness': { clientId: CLIENT } },
  },
}

type Opened = Awaited<ReturnType<typeof openTestHost>>
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

let nextId = 10
async function fixture() {
  const h: Opened = await openTestHost({ storeAttachmentsByReference: true })
  cleanup.push(() => h.close())
  const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
  cleanup.push(() => ep.close())
  await ep.handle(init)
  const created = (await ep.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/new',
    params: { cwd: h.dataDir, mcpServers: [] },
  })) as { result: { sessionId: string } }
  const sessionId = created.result.sessionId
  const session = h.host.kernel.get(sessionId)
  if (!session) throw new Error('session missing')
  // What an upload leaves behind: the object, and a marker naming the session that sent it.
  const store = createAttachmentStore({ dataDir: h.dataDir })
  const upload = async (text: string, owner: string) => {
    const bytes = Buffer.from(text)
    const object = await store.put(bytes, { kind: 'user-attachment', mimeType: 'application/zip' })
    await store.markUserAttachment(object, { mimeType: 'application/zip', receiptFor: owner })
    return {
      type: 'file' as const,
      mimeType: 'application/zip',
      name: `${text}.zip`,
      attachment: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength },
    }
  }
  const mine = await upload('mine', sessionId)
  const theirs = await upload('theirs', 'another-session')
  const forged = { ...mine, name: 'forged.zip', attachment: { sha256: 'f'.repeat(64), bytes: 4 } }
  const call = (method: string, params: unknown) =>
    ep.handle({ jsonrpc: '2.0', id: nextId++, method, params }) as Promise<{
      result?: unknown
      error?: { code: number; data?: unknown }
    }>
  const rows = async () => (await session.scan({ fromSeq: 1, limit: 500 })).length
  const queuedRefs = async () =>
    (await session.scan({ fromSeq: 1, limit: 500 }))
      .filter((row) => row.type === 'inbox' || row.type === 'user/message')
      .flatMap((row) => {
        const data = row.data as { content?: ContentBlock[]; items?: Array<{ content: ContentBlock[] }> }
        return [...(data.content ?? []), ...(data.items ?? []).flatMap((item) => item.content)]
      })
      .filter((block) => 'attachment' in block)
      .map((block) => (block as { attachment: { sha256: string } }).attachment.sha256)
  return { h, ep, sessionId, session, mine, theirs, forged, call, rows, queuedRefs }
}

describe('attachment references at every entry point', () => {
  it.each(['_agnes/v1/session.steer', '_agnes/v1/session.followUp'])('%s', async (method) => {
    const f = await fixture()
    const before = await f.rows()
    for (const [i, ref] of [f.forged, f.theirs].entries()) {
      const refused = await f.call(method, {
        sessionId: f.sessionId,
        content: [{ type: 'text', text: 'see' }, ref],
        commandId: `bad-${i}`,
      })
      expect(refused.error, JSON.stringify(refused)).toBeDefined()
    }
    expect(await f.rows()).toBe(before)
    const accepted = await f.call(method, {
      sessionId: f.sessionId,
      content: [{ type: 'text', text: 'see' }, f.mine],
      commandId: 'good',
    })
    expect(accepted.error).toBeUndefined()
    expect(await f.queuedRefs()).toContain(f.mine.attachment.sha256)
    expect(await f.queuedRefs()).not.toContain(f.forged.attachment.sha256)
  })

  it('ACP session/prompt', async () => {
    const f = await fixture()
    const before = await f.rows()
    const refused = await f.call('session/prompt', { sessionId: f.sessionId, prompt: [f.forged] })
    expect(refused.error).toBeDefined()
    expect(await f.rows()).toBe(before)
    expect(await f.queuedRefs()).toEqual([])
  })

  it('a scheduled job prompt', async () => {
    const f = await fixture()
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => 10_000)
    const entry = { key: f.sessionId, inflight: null, session: f.session }
    const registry: SchedulerRegistry = {
      open: async () => entry as never,
      get: () => entry as never,
      keys: () => [f.sessionId],
    }
    const scheduler = new Scheduler({
      repo,
      registry,
      notices: { emit() {} } as never,
      clock: () => 10_000,
      owner: 'owner',
      limits: { tickMs: 1_000, lockMs: 60_000, maxStalled: 5 },
      workspaces: {
        restoreBinding: async (sessionKey) =>
          ({
            version: 1,
            sessionKey,
            workspaceId: 'a'.repeat(64),
            revision: 1,
            canonicalRoot: f.h.dataDir,
          }) as WorkspaceBindingEnvelope,
      },
      ownership: { resolve: () => ({ active: true, principalId: 'owner' }) },
      activationBarrier: createExtensionActivationBarrier(),
      random: () => 0.5,
    })
    const job = (key: string, prompt: ContentBlock[]): JobRow => ({
      idempotencyKey: key,
      sessionKey: f.sessionId,
      profileHash: 'h',
      payload: { prompt },
      schedule: { kind: 'once' },
      status: 'waiting',
      attempts: 0,
      maxAttempts: 1,
      backoffMs: 1_000,
      delayUntil: 0,
      stalledCounter: 0,
      protected: false,
      createdAt: 0,
      updatedAt: 0,
    })
    const before = await f.rows()
    repo.insert(job('forged', [{ type: 'text', text: 'see' }, f.forged]))
    await scheduler.tick()
    await expect.poll(() => repo.get('forged')?.status).toBe('failed')
    expect(repo.get('forged')?.error).toMatch(/not uploaded to this session/)
    expect(await f.rows()).toBe(before)

    repo.insert(job('receipted', [{ type: 'text', text: 'see' }, f.mine]))
    await scheduler.tick()
    await expect.poll(() => repo.get('receipted')?.status).toBe('completed')
    expect(await f.queuedRefs()).toContain(f.mine.attachment.sha256)
  })
})
