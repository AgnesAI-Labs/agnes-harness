import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPlugin } from '@agnes/base'
import { MemoryStorage, type WorkspaceSaveRequest } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import type { MemoryProvider, PersistenceMetadataPort } from '@agnes/extension-api'
import { ServiceRegistry } from '@agnes/host-extensions/ext-host/services'
import { ProfileActivations } from '@agnes/host-extensions/profile/activation'
import { createProfileServiceRuntime } from '@agnes/host-extensions/profile/runtime'
import {
  APPROVAL_TTL_MS,
  normalizedContentHash,
  RefinementRegistry,
  type SaveReceipt,
} from '@agnes/host-infrastructure/refinement-registry'
import type { Actor, DecisionSnapshot } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRefinementApprovals,
  REFINEMENT_DECISION_OWNER,
} from '../../src/runtime/refinement/approvals.js'
import { WORKSPACE_MEMORY_KEY } from '../../src/runtime/refinement/reconcile.js'
import { registryView } from '../../src/runtime/refinement/registry-view.js'
import { INTENT_SETTLE_MS } from '../../src/runtime/refinement/workspace-commit.js'
import { createWorkspaceSave } from '../../src/runtime/refinement/workspace-save.js'

const dirs: string[] = []
const closing: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closing.splice(0)) await close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const T0 = Date.UTC(2026, 10, 4)
const TITLE = 'Build rules'
const BODY = 'Run pnpm lint before every commit; the hook rejects unformatted files.'
const actor: Actor = { id: 'operator', org: 'local', role: 'user', deptPath: [], attrs: {} }
const logger = { debug() {}, info() {}, warn() {}, error() {} }

const provider = (): MemoryProvider => {
  let found: MemoryProvider | undefined
  memoryPlugin.apply({
    providers: {
      register: (_kind: unknown, value: MemoryProvider) => {
        found = value
      },
    },
  } as never)
  if (!found) throw new Error('memory provider not registered')
  return found
}

function metadata(): PersistenceMetadataPort {
  const spaces = new Map<string, Map<string, unknown>>()
  return {
    namespace(owner, name) {
      const key = `${owner}\0${name}`
      const map = spaces.get(key) ?? new Map<string, unknown>()
      spaces.set(key, map)
      return {
        get: (k) => structuredClone(map.get(k)),
        set: (k, v) => {
          map.set(k, structuredClone(v))
        },
        delete: (k) => {
          map.delete(k)
        },
        entries: () => [...map].map(([k, v]) => ({ key: k, value: structuredClone(v) })),
        transaction: (work) => work(),
      }
    },
  }
}

/**
 * A workspace whose memory is under ask, the profile decision journal (in storage that outlives one
 * "process"), and the save service with its approvals. `restart` builds a fresh runtime, approvals and
 * service over the same storage and files, as a new process would, with no session open.
 */
async function workspace() {
  const home = mkdtempSync(join(tmpdir(), 'agnes-approvals-'))
  dirs.push(home)
  const root = join(home, 'ws')
  mkdirSync(root)
  const dataDir = join(home, 'data')
  const now = { value: T0 }
  const clock = () => now.value
  const switchState = { enabled: true, mode: 'auto' as 'auto' | 'manual', revision: 'r1' }
  const registry = () => new RefinementRegistry(dataDir, root, clock)
  const faults = { failWrites: false, hangCommit: false }
  const open = (sessionKey = WORKSPACE_MEMORY_KEY) =>
    provider().open({ home, workspaceRoot: root, sessionKey, validity: registryView(registry(), clock) })
  const storage = new MemoryStorage()
  const meta = metadata()
  const start = () => {
    const owners = new Map()
    const runtime = createProfileServiceRuntime({
      profileId: 'default',
      hostOwners: owners,
      registry: new ServiceRegistry(),
      activations: new ProfileActivations(meta.namespace('@host', 'activation')),
      storage,
      metadata: meta,
      log: logger,
      seams: fakeSeams({
        principals: {
          resolve: async () => actor,
          authorize: async () => ({ effect: 'allow', decisionId: 'permit', reason: 'fixture' }),
        },
      }),
      clock,
      signal: new AbortController().signal,
      networkAllow: [],
      audit: () => undefined,
    })
    closing.push(() => runtime.close())
    const settings = () => ({ ...switchState })
    const approvals = createRefinementApprovals({
      decisions: () => runtime.hostDecisions({ kind: 'local' }),
      registry: () => {
        const real = registry()
        // Writes made by the approvals fail while `failWrites` is set; reads still work.
        return Object.assign(Object.create(real), {
          // The edit runs, as it does before a write that then fails.
          update: (...args: Parameters<RefinementRegistry['update']>) => {
            if (!faults.failWrites) return real.update(...args)
            args[0](real.read())
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
          },
        }) as RefinementRegistry
      },
      memory: () => open(),
      settings,
      // `hangCommit` stands for a process that stops after taking the approval, before the commit ends.
      commit: (input) =>
        faults.hangCommit ? new Promise<never>(() => undefined) : save.commitApproved(input),
      clock,
    })
    owners.set(REFINEMENT_DECISION_OWNER, approvals.owner)
    const save = createWorkspaceSave({
      registry: () => registry(),
      settings,
      memory: () => open(),
      approvals,
      clock,
    })
    return { runtime, save }
  }
  await open().configure({ mode: 'ask' })
  const file = async () => (await open().readFile('MEMORY.md')).content
  const edit = async (content: string) => {
    const memory = open()
    await memory.editFile('MEMORY.md', content, (await memory.readFile('MEMORY.md')).hash)
  }
  let current = start()
  const list = () => current.runtime.listDecisions({ kind: 'local' })
  const answer = (snapshot: DecisionSnapshot, option = 'allowed-once') =>
    current.runtime.answerDecision(
      {
        handle: snapshot.handle,
        revision: snapshot.revision,
        commandId: `answer:${snapshot.handle.id}:${option}`,
        response: { option, value: null },
      },
      { kind: 'local' },
    )
  const receipt = (id: string) =>
    registry()
      .read()
      .receipts.find((entry) => entry.receiptId === id)
  return {
    root,
    dataDir,
    now,
    switchState,
    faults,
    /** The profile operations the approvals wrote, as the journal keeps them. */
    async operations() {
      return [...(await current.runtime.hostDecisions({ kind: 'local' })).journal.operations.values()]
    },
    registry,
    file,
    edit,
    list,
    answer,
    receipt,
    get save() {
      return current.save
    },
    async restart() {
      await current.runtime.close()
      current = start()
    },
  }
}
type Workspace = Awaited<ReturnType<typeof workspace>>

let commands = 0
const request = (ws: Workspace, over: Partial<WorkspaceSaveRequest> = {}): WorkspaceSaveRequest => ({
  initiator: 'model',
  commandId: `cmd-${++commands}`,
  session: { key: 'session-1', lane: 'main', workspaceRoot: ws.root, lastSeq: 40, child: false },
  settingsRevision: 'r1',
  entry: {
    kind: 'memory',
    id: 'build',
    version: 1,
    contentHash: 'core-hash',
    title: TITLE,
    content: BODY,
    applicability: 'session',
  },
  evidenceSeqs: [4, 9],
  evidenceTurn: 1,
  confirmations: 0,
  ...over,
})

/** The one registry file of the workspace. */
const registryFile = (ws: Workspace) => {
  const dir = join(ws.dataDir, 'refinement', 'workspaces')
  return join(dir, readdirSync(dir).find((name) => name.endsWith('.json')) as string)
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
type Subject = { path: string; baseHash: string; newHash: string; subjectRevision: string; diff: string }
const subjectOf = (snapshot: DecisionSnapshot | undefined) => snapshot?.request.spec.subject as Subject

/** Saves under ask; returns the awaiting receipt and the one decision it put in the list. */
async function ask(ws: Workspace): Promise<{ receipt: SaveReceipt; decision: DecisionSnapshot }> {
  const receipt = await ws.save.save(request(ws))
  expect(receipt).toMatchObject({ outcome: 'awaiting-approval' })
  const listed = await ws.list()
  expect(listed).toHaveLength(1)
  return { receipt, decision: listed[0] as DecisionSnapshot }
}

describe('background memory promotions wait in the profile decision list', () => {
  it('a pending promotion lists in profile.decisions.list without any plugin activation', async () => {
    const ws = await workspace()
    const before = await ws.file()
    const { receipt, decision } = await ask(ws)
    // Nothing is written while it waits.
    expect(await ws.file()).toBe(before)
    expect(decision.request).toMatchObject({ owner: REFINEMENT_DECISION_OWNER })
    // The exact change and its hashes are what the person approves; a person, never full access, answers.
    const subject = subjectOf(decision)
    expect(receipt.target).toMatchObject({ kind: 'memory-paragraph', fileHash: subject.newHash })
    expect(subject.path.endsWith('MEMORY.md')).toBe(true)
    expect(subject.subjectRevision).toBe(sha256(`${subject.baseHash}:${subject.newHash}`))
    expect(subject.diff).toContain(BODY)
    expect(decision.result).toBeNull()
    expect(Date.parse(decision.request.expiresAt ?? '')).toBe(T0 + APPROVAL_TTL_MS)
    // Approved: the exact proposal lands, once.
    await ws.answer(decision)
    expect(await ws.file()).toContain(BODY)
    expect(ws.receipt(receipt.receiptId)).toMatchObject({
      outcome: 'saved',
      target: { kind: 'memory-paragraph', fileHash: subject.newHash },
    })
    expect(ws.registry().read().paragraphs).toMatchObject([
      { state: 'active', contentHash: normalizedContentHash(`${TITLE}\n${BODY}`) },
    ])
    expect(await ws.list()).toEqual([])
  })

  it('approval after 7 days or with refinement off is withdrawn', async () => {
    const ws = await workspace()
    const before = await ws.file()
    const late = await ask(ws)
    ws.now.value = T0 + APPROVAL_TTL_MS
    expect(await ws.list()).toEqual([])
    await expect(ws.answer(late.decision)).rejects.toThrow()
    expect(ws.receipt(late.receipt.receiptId)).toMatchObject({
      outcome: 'refused',
      reason: 'approval-expired',
    })
    expect(await ws.file()).toBe(before)

    ws.now.value = T0
    const off = await ask(ws)
    ws.switchState.enabled = false
    // Off: withdrawn, and the registry is neither read nor written while refinement is off.
    const stored = readFileSync(registryFile(ws), 'utf8')
    expect(await ws.list()).toEqual([])
    await expect(ws.answer(off.decision)).rejects.toThrow()
    expect(readFileSync(registryFile(ws), 'utf8')).toBe(stored)
    // On again (a new revision): the ended request is settled, and stays ended.
    ws.switchState.enabled = true
    ws.switchState.revision = 'r2'
    expect(await ws.list()).toEqual([])
    expect(ws.receipt(off.receipt.receiptId)).toMatchObject({ outcome: 'refused', reason: 'refinement-off' })
    expect(await ws.file()).toBe(before)
  })

  it('a stale approval never writes and a re-enabled switch does not revive it', async () => {
    const ws = await workspace()
    const before = await ws.file()
    const { receipt, decision } = await ask(ws)
    // Switched off and on again: a new switch revision, so the old request is gone for good.
    ws.switchState.enabled = false
    ws.switchState.enabled = true
    ws.switchState.revision = 'r2'
    await expect(ws.answer(decision)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(await ws.list()).toEqual([])
    expect(ws.receipt(receipt.receiptId)).toMatchObject({ outcome: 'refused', reason: 'refinement-off' })
    expect(await ws.file()).toBe(before)
    // A file changed under a waiting approval: approving the old change writes nothing it did not show.
    ws.switchState.revision = 'r1'
    const second = await ask(ws)
    const edited = `${before.trimEnd()}\n- A line a person added.\n`
    await ws.edit(edited)
    await ws.answer(second.decision)
    expect(await ws.file()).toBe(edited)
    expect(ws.registry().read().paragraphs).toEqual([])
  })

  it('approval with a changed base asks again with the new diff', async () => {
    const ws = await workspace()
    const { receipt, decision } = await ask(ws)
    const old = subjectOf(decision)
    const edited = `${(await ws.file()).trimEnd()}\n- A line a person added.\n`
    await ws.edit(edited)
    ws.now.value = T0 + 6 * 86_400_000
    await ws.answer(decision)
    expect(await ws.file()).toBe(edited)
    const [again] = await ws.list()
    expect(again?.handle.id).not.toBe(decision.handle.id)
    const fresh = subjectOf(again)
    expect(fresh.baseHash).not.toBe(old.baseHash)
    expect(fresh.newHash).not.toBe(old.newHash)
    expect(fresh.diff).toContain(BODY)
    expect(fresh.subjectRevision).toBe(sha256(`${fresh.baseHash}:${fresh.newHash}`))
    // The same receipt waits, now for the new change.
    expect(ws.receipt(receipt.receiptId)).toMatchObject({
      outcome: 'awaiting-approval',
      target: { fileHash: fresh.newHash },
    })
    // The new request has a whole approval period of its own.
    ws.now.value = T0 + 12 * 86_400_000
    await ws.answer(again as DecisionSnapshot)
    const after = await ws.file()
    expect(after).toContain('- A line a person added.')
    expect(after).toContain(BODY)
    expect(ws.receipt(receipt.receiptId)).toMatchObject({
      outcome: 'saved',
      target: { fileHash: fresh.newHash },
    })
  })

  it("an archived session's pending promotion still lists and commits", async () => {
    const ws = await workspace()
    const { receipt } = await ask(ws)
    // A new process with no session open at all: the request belongs to the workspace, not the session.
    await ws.restart()
    const [decision] = await ws.list()
    expect(decision).toBeDefined()
    await ws.answer(decision as DecisionSnapshot)
    expect(await ws.file()).toContain(BODY)
    expect(ws.receipt(receipt.receiptId)).toMatchObject({ outcome: 'saved' })
  })

  it('a rejected promotion is refused as user-revoked and is not offered again', async () => {
    const ws = await workspace()
    const before = await ws.file()
    const { receipt, decision } = await ask(ws)
    await ws.answer(decision, 'rejected')
    expect(await ws.file()).toBe(before)
    expect(ws.receipt(receipt.receiptId)).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    expect(await ws.save.save(request(ws))).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    expect(await ws.list()).toEqual([])
  })

  it('content revoked while it waits withdraws the request', async () => {
    const ws = await workspace()
    const before = await ws.file()
    const { receipt, decision } = await ask(ws)
    const snapshot = ws.registry().read()
    ws.registry().update((draft) => {
      draft.revocations.push({
        sessionKey: 'another-session',
        kind: 'memory',
        entryId: 'other',
        contentHash: receipt.source.contentHash,
        action: 'memory-deleted',
        at: T0,
      })
    }, snapshot.revision)
    await expect(ws.answer(decision)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(await ws.list()).toEqual([])
    expect(ws.receipt(receipt.receiptId)).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    expect(await ws.file()).toBe(before)
  })

  it('a file that returns to an earlier state is asked about again, not silently dropped', async () => {
    const ws = await workspace()
    const original = await ws.file()
    const { receipt, decision } = await ask(ws)
    // A -> C: approving the change on A asks again for the change on C.
    await ws.edit(`${original.trimEnd()}\n- A line a person added.\n`)
    await ws.answer(decision)
    const [onC] = await ws.list()
    expect(onC).toBeDefined()
    // C -> A: approving the change on C asks again for the change on A, the very first change.
    await ws.edit(original)
    await ws.answer(onC as DecisionSnapshot)
    const [again] = await ws.list()
    expect(again).toBeDefined()
    expect(again?.handle.id).not.toBe(decision.handle.id)
    expect(subjectOf(again).newHash).toBe(subjectOf(decision).newHash)
    await ws.answer(again as DecisionSnapshot)
    expect(await ws.file()).toContain(BODY)
    expect(ws.receipt(receipt.receiptId)).toMatchObject({ outcome: 'saved' })
  })

  it('a receipt that cannot be moved to the new change asks nothing new', async () => {
    const ws = await workspace()
    const { receipt, decision } = await ask(ws)
    await ws.edit(`${(await ws.file()).trimEnd()}\n- A line a person added.\n`)
    ws.faults.failWrites = true
    await ws.answer(decision)
    ws.faults.failWrites = false
    // No request was put in front of the person for a change the receipt does not name, and the
    // operation says why it ended.
    expect((await ws.operations()).map((operation) => operation.receipt)).toMatchObject([
      { state: 'refused', code: 'REGISTRY_WRITE_FAILED' },
    ])
    expect(await ws.list()).toEqual([])
    expect(ws.receipt(receipt.receiptId)?.target).toMatchObject({ fileHash: subjectOf(decision).newHash })
  })

  it('a refusal the registry could not record is recorded once it can be', async () => {
    const ws = await workspace()
    const before = await ws.file()
    const { receipt, decision } = await ask(ws)
    ws.faults.failWrites = true
    await ws.answer(decision, 'rejected')
    expect(ws.receipt(receipt.receiptId)).toMatchObject({ outcome: 'awaiting-approval' })
    ws.faults.failWrites = false
    expect(await ws.list()).toEqual([])
    expect(ws.receipt(receipt.receiptId)).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    expect(ws.registry().read().revocations).toHaveLength(1)
    expect(await ws.file()).toBe(before)
  })

  it('a waiting approval survives hundreds of later receipts and still commits', async () => {
    const ws = await workspace()
    const { receipt, decision } = await ask(ws)
    const store = ws.registry()
    store.update((draft) => {
      for (let i = 0; i < 600; i++)
        draft.receipts.push({
          ...receipt,
          receiptId: `later-${i}`,
          commandId: `later-${i}`,
          outcome: 'refused',
          reason: 'memory-off',
          at: T0 + i,
        })
    }, store.read().revision)
    expect(ws.receipt(receipt.receiptId)).toMatchObject({ outcome: 'awaiting-approval' })
    await ws.answer(decision)
    expect(await ws.file()).toContain(BODY)
    expect(ws.receipt(receipt.receiptId)).toMatchObject({ outcome: 'saved' })
  })

  it('an approval taken just before the process stopped is committed when the list is next read', async () => {
    const ws = await workspace()
    const { receipt, decision } = await ask(ws)
    ws.faults.hangCommit = true
    void ws.answer(decision)
    await vi.waitFor(async () =>
      expect((await ws.operations()).map((operation) => operation.receipt.state)).toEqual(['running']),
    )
    ws.faults.hangCommit = false
    await ws.restart()
    expect(await ws.file()).not.toContain(BODY)
    await ws.list()
    await vi.waitFor(async () => expect(await ws.file()).toContain(BODY))
    expect(ws.receipt(receipt.receiptId)).toMatchObject({ outcome: 'saved' })
    await vi.waitFor(async () =>
      expect((await ws.operations()).map((operation) => operation.receipt.state)).toEqual(['completed']),
    )
    // Read again: nothing runs twice.
    await ws.list()
    expect((await ws.file()).split(BODY)).toHaveLength(2)
  })

  it('a waiting receipt no request in the decision list names is settled once it is old enough', async () => {
    const ws = await workspace()
    const { receipt } = await ask(ws)
    const store = ws.registry()
    // A save that stopped after recording its waiting receipt, before its request reached the list.
    store.update((draft) => {
      draft.receipts.push({ ...receipt, receiptId: 'orphan', commandId: 'orphan' })
    }, store.read().revision)
    await ws.save.resume(ws.root)
    expect(ws.receipt('orphan')).toMatchObject({ outcome: 'awaiting-approval' })
    ws.now.value = T0 + INTENT_SETTLE_MS
    await ws.save.resume(ws.root)
    expect(ws.receipt('orphan')).toMatchObject({ outcome: 'refused', reason: 'unavailable' })
    expect(ws.receipt('orphan')).not.toHaveProperty('target')
    // The one the list names keeps waiting.
    expect(ws.receipt(receipt.receiptId)).toMatchObject({ outcome: 'awaiting-approval' })
  })

  it('a change too long for the card is clipped with a note, not left out', async () => {
    const ws = await workspace()
    await ws.edit(
      'A long human preference line that fills the index with ordinary memory text.\n'.repeat(150),
    )
    const { decision } = await ask(ws)
    const presentation = (
      decision.request.spec.presentation as Record<string, { fields: { label: string; value: string }[] }>
    ).en
    const change = presentation?.fields.find((field) => field.label === 'Exact change')
    expect(change?.value.length).toBeLessThanOrEqual(8192)
    expect(change?.value).toMatch(/full change is in the request details\]$/)
    expect(subjectOf(decision).diff.length).toBeGreaterThan(8192)
  })
})
