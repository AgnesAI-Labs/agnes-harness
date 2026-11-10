import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPlugin } from '@agnes/base'
import type { WorkspaceSaveRequest } from '@agnes/core'
import type { MemoryProvider, MemorySession } from '@agnes/extension-api'
import {
  normalizedContentHash,
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type SaveReceipt,
} from '@agnes/host-infrastructure/refinement-registry'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRefinementHost } from '../../src/runtime/assemble/refinement.js'
import { WORKSPACE_MEMORY_KEY } from '../../src/runtime/refinement/reconcile.js'
import { registryView } from '../../src/runtime/refinement/registry-view.js'
import { createUserSave, routedSaves } from '../../src/runtime/refinement/user-save.js'
import { manageUserSections } from '../../src/runtime/refinement/user-sections.js'
import { createWorkspaceSave } from '../../src/runtime/refinement/workspace-save.js'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const T0 = Date.UTC(2026, 10, 4)
const TITLE = 'Answers'
const BODY = 'Answer in short sentences; the user reads on a phone.'
const TEXT = `${TITLE}\n${BODY}`
const HAND = '# Preferences\n\n- Prefer pnpm over npm.\n'

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

type Wrap = (session: MemorySession) => MemorySession

/**
 * A home with one workspace, the bundled file memory, the user memory registry, a switch the test can
 * move, and the one save path (workspace saves and promotions to user memory).
 */
async function home(o: { mode?: 'off' | 'ask' | 'auto'; userEnabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-promote-user-'))
  dirs.push(dir)
  const root = join(dir, 'shop')
  mkdirSync(root)
  const dataDir = join(dir, 'data')
  const now = { value: T0 }
  const clock = () => now.value
  const switchState = { enabled: true, mode: 'auto' as 'auto' | 'manual', revision: 'r1' }
  const users = () => RefinementRegistry.user(dir, clock)
  const local = () => new RefinementRegistry(dataDir, root, clock)
  const open = (sessionKey = WORKSPACE_MEMORY_KEY) =>
    provider().open({
      home: dir,
      workspaceRoot: root,
      sessionKey,
      validity: registryView(local(), clock),
      userValidity: registryView(users(), clock),
    })
  let wrap: Wrap = (session) => session
  const memory = () => wrap(open())
  const settings = () => ({ ...switchState })
  const saves = routedSaves(
    createWorkspaceSave({ registry: () => local(), settings, memory, clock }),
    createUserSave({ registry: users, workspaceRegistry: () => local(), settings, memory, clock }),
  )
  await open().configure({ mode: o.mode ?? 'auto', userEnabled: o.userEnabled ?? true })
  const userFile = join(dir, 'memory', 'user', 'MEMORY.md')
  mkdirSync(join(dir, 'memory', 'user'), { recursive: true })
  writeFileSync(userFile, HAND)
  return {
    dir,
    root,
    dataDir,
    now,
    switchState,
    users,
    local,
    open,
    saves,
    userFile,
    user: () => readFileSync(userFile, 'utf8'),
    workspaceFile: async () => (await open().readFile('MEMORY.md')).content,
    setWrap(next: Wrap) {
      wrap = next
    },
    manage: (request: Parameters<typeof manageUserSections>[2]) =>
      manageUserSections(open('human-editor'), users(), request, clock),
  }
}
type Home = Awaited<ReturnType<typeof home>>

let commands = 0
const request = (h: Home, over: Partial<WorkspaceSaveRequest> = {}): WorkspaceSaveRequest => ({
  initiator: 'auto',
  target: 'user',
  commandId: `auto:${++commands}`,
  session: { key: 'session-1', lane: 'main', workspaceRoot: h.root, lastSeq: 40, child: false },
  settingsRevision: 'r1',
  entry: {
    kind: 'memory',
    id: 'short',
    version: 1,
    contentHash: 'core-hash',
    title: TITLE,
    content: BODY,
    applicability: 'session',
  },
  evidenceSeqs: [4, 9],
  evidenceTurn: 1,
  confirmations: 2,
  ...over,
})
const withContent = (h: Home, content: string, over: Partial<WorkspaceSaveRequest> = {}) =>
  request(h, { entry: { ...request(h).entry, content }, ...over })

const marked = (id: string, text: string) =>
  `<!-- refinement:${id} -->\n${text}\n<!-- /refinement:${id} -->\n`
const sectionId = (receipt: SaveReceipt) =>
  receipt.target?.kind === 'memory-paragraph' ? receipt.target.paragraphId : 'none'
const verdicts = (receipt: SaveReceipt) => receipt.steps.map((step) => `${step.step}:${step.verdict}`)

describe('promoting a confirmed lesson to user memory', () => {
  it('a lesson confirmed twice with reach user is written to user memory without asking', async () => {
    // Workspace memory under ask: a promotion to user memory still asks nobody.
    const h = await home({ mode: 'ask' })
    const receipt = await h.saves.save(request(h))
    expect(receipt).toMatchObject({
      outcome: 'saved',
      layer: 'user',
      initiator: 'auto',
      userMemoryRead: true,
    })
    const id = sectionId(receipt)
    expect(h.user()).toBe(`${HAND}\n${marked(id, TEXT)}`)
    expect(h.users().read().paragraphs).toEqual([
      expect.objectContaining({
        id,
        state: 'active',
        reviewAfter: T0 + REVIEW_AFTER_MS,
        contentHash: normalizedContentHash(TEXT),
      }),
    ])
    // Nothing went to the workspace, and its registry holds nothing.
    expect(await h.workspaceFile()).toBe('')
    expect(existsSync(join(h.dataDir, 'refinement', 'workspaces'))).toBe(false)
    // The section is in force: the agent reads it after the hand-written text.
    expect((await h.open('reader').snapshot(1))?.content).toContain(`- Prefer pnpm over npm.\n\n${TEXT}`)
    // The same command again is answered with the first receipt; nothing is written twice.
    expect(await h.saves.save({ ...request(h), commandId: receipt.commandId })).toEqual(receipt)
  })

  it('a lesson that was never seen to hold is not promoted, one seen once is', async () => {
    const h = await home()
    const receipt = await h.saves.save(request(h, { confirmations: 0 }))
    expect(receipt).toMatchObject({ outcome: 'refused', reason: 'unconfirmed', layer: 'user' })
    expect(verdicts(receipt)).toEqual([
      'switch:pass',
      'revocation:pass',
      'confirmations:fail',
      'rules:skip',
      'memory-mode:skip',
      'capacity:skip',
    ])
    expect(h.user()).toBe(HAND)
    expect(await h.saves.save(request(h, { confirmations: 1 }))).toMatchObject({
      outcome: 'saved',
      layer: 'user',
    })
  })

  it('content naming a workspace falls back to workspace level', async () => {
    const h = await home()
    for (const content of [`Run make in ${h.root}/api first.`, 'In shop, run make first.']) {
      const receipt = await h.saves.save(withContent(h, content))
      expect(receipt).toMatchObject({ outcome: 'saved', initiator: 'auto' })
      expect(receipt).not.toHaveProperty('layer')
      expect(await h.workspaceFile()).toContain(content)
    }
    expect(h.user()).toBe(HAND)
  })

  it('the gate order is the same from every entry point', async () => {
    const h = await home()
    h.switchState.revision = 'r2'
    expect(verdicts(await h.saves.save(request(h)))[0]).toBe('switch:fail')
    h.switchState.revision = 'r1'
    const secret = await h.saves.save(withContent(h, 'Use api_key=synthetic-sensitive-key here.'))
    expect(secret).toMatchObject({ outcome: 'refused', reason: 'source-rules' })
    expect(verdicts(secret).slice(0, 4)).toEqual([
      'switch:pass',
      'revocation:pass',
      'confirmations:pass',
      'rules:fail',
    ])
    const child = await h.saves.save(request(h, { session: { ...request(h).session, child: true } }))
    expect(child).toMatchObject({ outcome: 'refused', reason: 'child-session' })
    const task = await h.saves.save(request(h, { entry: { ...request(h).entry, applicability: 'task' } }))
    expect(task).toMatchObject({ outcome: 'refused', reason: 'source-rules' })
    expect(h.user()).toBe(HAND)
  })

  it('secret-looking content is refused by the same check as workspace memory', async () => {
    const h = await home()
    for (const content of [
      `token ghp_${'a'.repeat(30)} works`,
      `${'-'.repeat(5)}BEGIN RSA ${['PRIVATE', 'KEY'].join(' ')}${'-'.repeat(5)} in the notes`,
      'password: hunter2hunter2',
    ])
      expect(await h.saves.save(withContent(h, content))).toMatchObject({
        outcome: 'refused',
        reason: 'source-rules',
      })
    expect(h.user()).toBe(HAND)
  })

  it('a promotion that would push user memory past its budget is refused and writes nothing', async () => {
    const h = await home()
    const hand = `${'- A preference the person wrote by hand.\n'.repeat(50)}`
    writeFileSync(h.userFile, hand)
    const receipt = await h.saves.save(request(h))
    expect(receipt).toMatchObject({ outcome: 'refused', reason: 'user-memory-budget', layer: 'user' })
    expect(verdicts(receipt).at(-1)).toBe('capacity:fail')
    expect(h.user()).toBe(hand)
    expect(h.users().read().paragraphs).toEqual([])
  })

  it('switching refinement off stops promotions, including one already past the gate', async () => {
    const h = await home()
    // The switch goes off after every step has passed, while the section is being proposed.
    h.setWrap((session) => ({
      ...session,
      userParagraphs: (source, signal) => {
        const port = session.userParagraphs?.(source, signal)
        if (!port) throw new Error('no port')
        return {
          ...port,
          propose: async (changes, base) => {
            const proposal = await port.propose(changes, base)
            h.switchState.enabled = false
            return proposal
          },
        }
      },
    }))
    const receipt = await h.saves.save(request(h))
    expect(receipt).toMatchObject({ outcome: 'refused', reason: 'refinement-off' })
    expect(h.user()).toBe(HAND)
    expect(h.users().read().paragraphs).toEqual([])
    // Off, nothing is asked at all.
    expect(await h.saves.save(request(h))).toMatchObject({ outcome: 'refused', reason: 'refinement-off' })
  })

  it('withdrawing a user-level promotion removes the section and its registry entry and blocks re-promotion', async () => {
    const h = await home()
    const saved = await h.saves.save(request(h))
    const id = sectionId(saved)
    expect((await h.manage({ action: 'list', layer: 'user' })).paragraphs).toEqual([
      expect.objectContaining({
        id,
        validity: 'valid',
        initiator: 'auto',
        reviewAfter: T0 + REVIEW_AFTER_MS,
      }),
    ])
    expect((await h.manage({ action: 'withdraw', paragraphId: id, layer: 'user' })).paragraphs).toEqual([])
    expect(h.user()).toBe(HAND)
    expect(h.users().read().paragraphs).toEqual([expect.objectContaining({ id, state: 'removed' })])
    expect(h.users().read().revocations).toEqual([expect.objectContaining({ action: 'memory-withdrawn' })])
    // Old confirmations do not bring it back, under any command, from any session.
    const again = await h.saves.save(request(h, { session: { ...request(h).session, key: 'session-2' } }))
    expect(again).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    expect(h.user()).toBe(HAND)
  })

  it('a section the user deleted by hand is not promoted again on old confirmations', async () => {
    const h = await home()
    await h.saves.save(request(h))
    writeFileSync(h.userFile, HAND)
    const again = await h.saves.save(request(h))
    expect(again).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    expect(h.users().read().revocations).toEqual([expect.objectContaining({ action: 'memory-deleted' })])
    expect(h.user()).toBe(HAND)
  })

  it('content taken back from this workspace is not promoted to user memory either', async () => {
    const h = await home()
    h.local().update((draft) => {
      draft.revocations.push({
        sessionKey: 'earlier',
        kind: 'memory',
        entryId: 'other',
        contentHash: normalizedContentHash(BODY),
        action: 'memory-withdrawn',
        at: T0,
      })
    }, h.local().read().revision)
    expect(await h.saves.save(request(h))).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    expect(h.user()).toBe(HAND)
  })

  it('a person editing a promoted section is never overwritten by a later promotion', async () => {
    const h = await home()
    const id = sectionId(await h.saves.save(request(h)))
    const edited = `${HAND}\n${marked(id, `${TITLE}\nAnswer briefly, as I wrote it.`)}`
    writeFileSync(h.userFile, edited)
    const next = await h.saves.save(withContent(h, 'Answer in very short sentences.'))
    expect(next).toMatchObject({ outcome: 'refused', reason: 'conflict' })
    expect(h.user()).toBe(edited)
  })

  it('the receipt says when the current workspace does not read user memory', async () => {
    for (const settings of [
      { mode: 'off', userEnabled: true },
      { mode: 'auto', userEnabled: false },
    ] as const) {
      const h = await home(settings)
      const receipt = await h.saves.save(request(h))
      expect(receipt).toMatchObject({ outcome: 'saved', layer: 'user', userMemoryRead: false })
      expect(h.user()).toContain(TEXT)
      // Nothing turns reading on.
      expect((await h.open().inspect()).settings).toMatchObject(settings)
    }
  })

  it('a provider without writeUserSection is refused, not bypassed', async () => {
    const h = await home()
    h.setWrap(({ userParagraphs: _gone, ...session }) => session)
    const receipt = await h.saves.save(request(h))
    expect(receipt).toMatchObject({ outcome: 'refused', reason: 'unsupported-provider' })
    expect(verdicts(receipt)[4]).toBe('memory-mode:fail')
    expect(h.user()).toBe(HAND)
  })
})

describe("saving to user memory on the user's request", () => {
  /** A person's own request: no confirmations, and no reach the planner suggested. */
  const asked = (h: Home, over: Partial<WorkspaceSaveRequest> = {}) =>
    request(h, { initiator: 'user', confirmations: 0, commandId: `run-1:${++commands}`, ...over })
  const askedWith = (h: Home, content: string) => asked(h, { entry: { ...request(h).entry, content } })

  it("skips the confirmation count and writes one section, as the user's", async () => {
    const h = await home({ mode: 'ask' })
    const receipt = await h.saves.save(asked(h))
    expect(receipt).toMatchObject({
      outcome: 'saved',
      layer: 'user',
      initiator: 'user',
      userMemoryRead: true,
    })
    expect(verdicts(receipt)).toEqual([
      'switch:pass',
      'revocation:pass',
      'confirmations:skip',
      'rules:pass',
      'memory-mode:pass',
      'capacity:pass',
    ])
    const id = sectionId(receipt)
    expect(h.user()).toBe(`${HAND}\n${marked(id, TEXT)}`)
    expect(h.users().read().paragraphs).toEqual([
      expect.objectContaining({ id, state: 'active', reviewAfter: T0 + REVIEW_AFTER_MS }),
    ])
    expect(await h.workspaceFile()).toBe('')
    // Listed on the memory page, where it can be withdrawn.
    expect((await h.manage({ action: 'list', layer: 'user' })).paragraphs).toEqual([
      expect.objectContaining({ id, validity: 'valid', initiator: 'user' }),
    ])
    expect(await h.saves.save({ ...asked(h), commandId: receipt.commandId })).toEqual(receipt)
  })

  it('is refused past the user memory budget and trims nothing', async () => {
    const h = await home()
    const hand = `${'- A preference the person wrote by hand.\n'.repeat(50)}`
    writeFileSync(h.userFile, hand)
    const receipt = await h.saves.save(asked(h))
    expect(receipt).toMatchObject({ outcome: 'refused', reason: 'user-memory-budget', layer: 'user' })
    expect(h.user()).toBe(hand)
    expect(h.users().read().paragraphs).toEqual([])
  })

  it('keeps content that names the workspace in the workspace and says so in the receipt', async () => {
    const h = await home()
    for (const content of [`Run make in ${h.root}/api first.`, 'In shop, run make first.']) {
      const receipt = await h.saves.save(askedWith(h, content))
      expect(receipt).toMatchObject({ outcome: 'saved', initiator: 'user' })
      expect(receipt).not.toHaveProperty('layer')
      expect(await h.workspaceFile()).toContain(content)
    }
    expect(h.user()).toBe(HAND)
  })

  it('applies the secret and source rules like the automatic promotion', async () => {
    const h = await home()
    const secret = await h.saves.save(askedWith(h, 'Use api_key=synthetic-sensitive-key here.'))
    expect(secret).toMatchObject({ outcome: 'refused', reason: 'source-rules', layer: 'user' })
    const task = await h.saves.save(asked(h, { entry: { ...request(h).entry, applicability: 'task' } }))
    expect(task).toMatchObject({ outcome: 'refused', reason: 'source-rules' })
    const skill = await h.saves.save(asked(h, { entry: { ...request(h).entry, kind: 'skill' } }))
    expect(skill).toMatchObject({ outcome: 'refused', reason: 'source-rules' })
    const child = await h.saves.save(asked(h, { session: { ...request(h).session, child: true } }))
    expect(child).toMatchObject({ outcome: 'refused', reason: 'child-session' })
    expect(h.user()).toBe(HAND)
  })

  it('is refused while refinement is off, and when it goes off before the write', async () => {
    const h = await home()
    h.switchState.enabled = false
    expect(await h.saves.save(asked(h))).toMatchObject({ outcome: 'refused', reason: 'refinement-off' })
    h.switchState.enabled = true
    h.switchState.revision = 'r2'
    expect(verdicts(await h.saves.save(asked(h)))[0]).toBe('switch:fail')
    h.switchState.revision = 'r1'
    h.setWrap((session) => ({
      ...session,
      userParagraphs: (source, signal) => {
        const port = session.userParagraphs?.(source, signal)
        if (!port) throw new Error('no port')
        return {
          ...port,
          propose: async (changes, base) => {
            const proposal = await port.propose(changes, base)
            h.switchState.enabled = false
            return proposal
          },
        }
      },
    }))
    expect(await h.saves.save(asked(h))).toMatchObject({ outcome: 'refused', reason: 'refinement-off' })
    expect(h.user()).toBe(HAND)
    expect(h.users().read().paragraphs).toEqual([])
  })

  it('is blocked by a withdrawal from user memory or from this workspace', async () => {
    const h = await home()
    const saved = await h.saves.save(asked(h))
    await h.manage({ action: 'withdraw', paragraphId: sectionId(saved), layer: 'user' })
    expect(await h.saves.save(asked(h))).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    expect(h.user()).toBe(HAND)
    const w = await home()
    w.local().update((draft) => {
      draft.revocations.push({
        sessionKey: 'earlier',
        kind: 'memory',
        entryId: 'other',
        contentHash: normalizedContentHash(BODY),
        action: 'memory-withdrawn',
        at: T0,
      })
    }, w.local().read().revision)
    expect(await w.saves.save(asked(w))).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    expect(w.user()).toBe(HAND)
  })

  it('records that this workspace does not read user memory and changes no setting', async () => {
    const h = await home({ mode: 'auto', userEnabled: false })
    const receipt = await h.saves.save(asked(h))
    expect(receipt).toMatchObject({
      outcome: 'saved',
      layer: 'user',
      initiator: 'user',
      userMemoryRead: false,
    })
    expect((await h.open().inspect()).settings).toMatchObject({ mode: 'auto', userEnabled: false })
  })

  it('is saved the same way when the model asks', async () => {
    const h = await home()
    const receipt = await h.saves.save(asked(h, { initiator: 'model' }))
    expect(receipt).toMatchObject({ outcome: 'saved', layer: 'user', initiator: 'model' })
    expect(h.user()).toContain(TEXT)
    // The model's request meets the same budget and name checks.
    const w = await home()
    expect(await w.saves.save(askedWith(w, `Run make in ${w.root}/api first.`))).not.toHaveProperty('layer')
    writeFileSync(w.userFile, `${'- A preference the person wrote by hand.\n'.repeat(50)}`)
    expect(await w.saves.save(asked(w, { initiator: 'model' }))).toMatchObject({
      outcome: 'refused',
      reason: 'user-memory-budget',
    })
  })
})

describe('the user memory registry', () => {
  const PROFILE_A = 'a'
  const PROFILE_B = 'b'
  it('two profiles on one home read the same user registry, whatever their data directories', async () => {
    const h = await home()
    // Each profile with a data directory of its own (one in the standard place, one elsewhere).
    const elsewhere = join(h.dir, 'custom-data')
    const hosts = [
      [h.dataDir, PROFILE_A],
      [elsewhere, PROFILE_B],
    ].map(([dataDir, profile]) => {
      const store = new RefinementSettingsStore(dataDir as string, profile as string)
      store.save({ enabled: true, mode: 'auto' }, store.read().revision)
      return createRefinementHost(dataDir as string, profile as string, () => h.now.value, { home: h.dir })
    })
    const id = sectionId(await h.saves.save(request(h)))
    for (const host of hosts) {
      expect(host.workspace.userRegistry().validity(id, h.now.value)).toBe('valid')
      // In force, and given to the model through the task-experience snapshot.
      expect(host.workspace.userValidity().validity(id)).toBe('delivered')
    }
    // The records sit next to the user memory file, not in any data directory.
    expect(existsSync(join(h.dir, 'memory', 'user', 'refinement.json'))).toBe(true)
    expect(existsSync(join(h.dataDir, 'refinement', 'user.json'))).toBe(false)
  })

  it('renewal never writes the memory file', async () => {
    const h = await home()
    const id = sectionId(await h.saves.save(request(h)))
    const stored = h.user()
    h.now.value = T0 + REVIEW_AFTER_MS + 1
    expect((await h.open('reader').snapshot(1))?.content).not.toContain(BODY)
    await h.manage({ action: 'renew', paragraphId: id, layer: 'user' })
    expect(h.users().read().paragraphs[0]?.reviewAfter).toBe(h.now.value + REVIEW_AFTER_MS)
    expect(h.user()).toBe(stored)
    expect((await h.open('reader').snapshot(2))?.content).toContain(BODY)
  })

  it('switching refinement off writes nothing to the registry', async () => {
    const h = await home()
    h.switchState.enabled = false
    expect(await h.saves.save(request(h))).toMatchObject({ outcome: 'refused', reason: 'refinement-off' })
    const promotions = createUserSave({
      registry: h.users,
      workspaceRegistry: h.local,
      settings: () => ({ ...h.switchState }),
      memory: () => h.open(),
      clock: () => h.now.value,
    })
    await promotions.resume(h.root)
    expect(await promotions.settled(['x'])).toEqual([])
    expect(existsSync(join(h.dataDir, 'refinement'))).toBe(false)
    expect(existsSync(join(h.dir, 'memory', 'user', 'refinement.json'))).toBe(false)
  })

  it('a corrupt user registry reads as unverifiable, not as valid', async () => {
    const h = await home()
    const id = sectionId(await h.saves.save(request(h)))
    writeFileSync(join(h.dir, 'memory', 'user', 'refinement.json'), '{"version":1,"revision":"broken"')
    const content = (await h.open('reader').snapshot(1))?.content ?? ''
    expect(content).not.toContain(BODY)
    expect(content).toContain('[1 task-experience paragraphs omitted: expired or unverifiable]')
    expect(h.users().validity(id, h.now.value)).toBe('unknown')
    // Nothing can be ruled out, so nothing is promoted.
    const next = await h.saves.save(withContent(h, 'Prefer tabs.'))
    expect(next).toMatchObject({ outcome: 'refused', reason: 'unavailable' })
  })
})
