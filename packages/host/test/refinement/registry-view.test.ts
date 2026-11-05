import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPlugin } from '@agnes/base'
import type { MemoryProvider, MemoryValidityView } from '@agnes/extension-api'
import {
  normalizedContentHash,
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistryParagraph,
} from '@agnes/host-infrastructure/refinement-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registryView } from '../../src/runtime/refinement/registry-view.js'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-registry-view-'))
  dirs.push(dir)
  return dir
}

const T0 = Date.UTC(2026, 10, 4)
const source = {
  sessionKey: 's',
  kind: 'memory' as const,
  entryId: 'e',
  contentHash: normalizedContentHash('x'),
  initiator: 'auto' as const,
}
const paragraph = (id: string, savedAt: number, state: RegistryParagraph['state'] = 'active') => ({
  id,
  source,
  contentHash: normalizedContentHash(id),
  reviewAfter: savedAt + REVIEW_AFTER_MS,
  state,
  fileHash: 'f',
})
const seed = (registry: RefinementRegistry, paragraphs: RegistryParagraph[]) =>
  registry.update((draft) => {
    draft.paragraphs.push(...paragraphs)
  }, registry.read().revision)

/** A clock a test moves by hand; the view reads it once per synchronous burst. */
const clockAt = (start: number) => {
  let now = start
  return {
    now: () => now,
    set: (to: number) => {
      now = to
    },
  }
}
/** Lets the view drop the answers it held for the burst that just ran. */
const nextBurst = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('the validity view the Host gives memory', () => {
  it('the view answers expired once the clock passes reviewAfter and its revision changes', async () => {
    const clock = clockAt(T0)
    const registry = new RefinementRegistry(scratch(), '/ws', clock.now)
    seed(registry, [paragraph('ra000000001', T0)])
    const view = registryView(registry, clock.now)
    expect(view.validity('ra000000001')).toBe('valid')
    const before = view.revision()
    await nextBurst()
    clock.set(T0 + REVIEW_AFTER_MS - 1)
    expect(view.validity('ra000000001')).toBe('valid')
    expect(view.revision()).toBe(before)
    await nextBurst()
    clock.set(T0 + REVIEW_AFTER_MS)
    expect(view.validity('ra000000001')).toBe('expired')
    expect(view.revision()).not.toBe(before)
  })

  it('answers delivered for a paragraph in force when the Host gives it to the model itself', async () => {
    const clock = clockAt(T0)
    const registry = new RefinementRegistry(scratch(), '/ws', clock.now)
    seed(registry, [paragraph('ra000000001', T0)])
    const view = registryView(registry, clock.now, undefined, 'delivered')
    expect(view.validity('ra000000001')).toBe('delivered')
    await nextBurst()
    clock.set(T0 + REVIEW_AFTER_MS)
    expect(view.validity('ra000000001')).toBe('expired')
  })

  it('answers unknown for ids it does not hold as active, and for an empty registry', () => {
    const clock = clockAt(T0)
    const registry = new RefinementRegistry(scratch(), '/ws', clock.now)
    const view = registryView(registry, clock.now)
    expect(view.validity('ra000000001')).toBe('unknown')
    seed(registry, [paragraph('rb000000001', T0, 'converted'), paragraph('rc000000001', T0, 'removed')])
    const fresh = registryView(registry, clock.now)
    expect(fresh.validity('rb000000001')).toBe('unknown')
    expect(fresh.validity('rc000000001')).toBe('unknown')
    expect(fresh.validity('ra000000001')).toBe('unknown')
  })

  it('the revision moves only when an answer can change', async () => {
    const clock = clockAt(T0)
    const registry = new RefinementRegistry(scratch(), '/ws', clock.now)
    const view = registryView(registry, clock.now)
    const empty = view.revision()
    seed(registry, [paragraph('ra000000001', T0)])
    await nextBurst()
    const one = view.revision()
    expect(one).not.toBe(empty)
    // A receipt, a revocation or a converted record changes no answer for an active id.
    registry.update((draft) => {
      draft.receipts.push({
        receiptId: 'r1',
        commandId: 'c1',
        initiator: 'auto',
        source,
        outcome: 'refused',
        reason: 'memory-off',
        steps: [],
        at: T0,
      })
      draft.revocations.push({ ...source, action: 'memory-withdrawn', at: T0 })
      draft.paragraphs.push(paragraph('rb000000001', T0, 'removed'))
    }, registry.read().revision)
    await nextBurst()
    expect(view.revision()).toBe(one)
    // Renewing a paragraph that is still valid moves its date, not its answer.
    clock.set(T0 + 1000)
    registry.renew({ paragraphId: 'ra000000001' })
    await nextBurst()
    expect(view.revision()).toBe(one)
    // Removing the active paragraph does change an answer.
    registry.update((draft) => {
      for (const entry of draft.paragraphs) if (entry.id === 'ra000000001') entry.state = 'removed'
    }, registry.read().revision)
    await nextBurst()
    expect(view.revision()).toBe(empty)
  })

  it('a registry file that cannot be believed makes nothing valid', () => {
    const dataDir = scratch()
    const clock = clockAt(T0)
    const registry = new RefinementRegistry(dataDir, '/ws', clock.now)
    seed(registry, [paragraph('ra000000001', T0)])
    const dir = join(dataDir, 'refinement', 'workspaces')
    mkdirSync(dir, { recursive: true })
    const file = readdirSync(dir).find((name) => name.endsWith('.json'))
    if (!file) throw new Error('registry file missing')
    writeFileSync(join(dir, file), '{"version":1,"revision":"broken"')
    const view = registryView(registry, clock.now)
    expect(view.validity('ra000000001')).toBe('unknown')
    expect(view.revision()).toBe(
      registryView(new RefinementRegistry(scratch(), '/ws', clock.now), clock.now).revision(),
    )
  })

  it('reads the registry once per synchronous burst and never throws', async () => {
    const clock = clockAt(T0)
    const registry = new RefinementRegistry(scratch(), '/ws', clock.now)
    seed(registry, [paragraph('ra000000001', T0), paragraph('rb000000001', T0)])
    const read = vi.spyOn(registry, 'read')
    const view = registryView(registry, clock.now)
    view.revision()
    view.validity('ra000000001')
    view.validity('rb000000001')
    view.validity('rc000000001')
    expect(read).toHaveBeenCalledTimes(1)
    await nextBurst()
    view.validity('ra000000001')
    expect(read).toHaveBeenCalledTimes(2)
    await nextBurst()
    read.mockImplementation(() => {
      throw new Error('disk gone')
    })
    expect(view.validity('ra000000001')).toBe('unknown')
    expect(() => view.revision()).not.toThrow()
    const broken: MemoryValidityView = registryView(registry, () => {
      throw new Error('no clock')
    })
    await nextBurst()
    expect(broken.validity('ra000000001')).toBe('unknown')
    expect(typeof broken.revision()).toBe('string')
  })
})

describe('the bundled memory provider with the validity view', () => {
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
  const marked = (id: string, text: string) =>
    `<!-- refinement:${id} -->\n${text}\n<!-- /refinement:${id} -->`

  it('shows a valid paragraph, leaves out an expired one, and the revision follows the clock', async () => {
    const home = scratch()
    const workspace = join(home, 'ws')
    mkdirSync(workspace)
    const clock = clockAt(T0)
    const registry = new RefinementRegistry(join(home, 'data'), workspace, clock.now)
    seed(registry, [paragraph('ra000000001', T0), paragraph('rb000000001', T0 - REVIEW_AFTER_MS)])
    const open = () =>
      provider().open({
        home,
        workspaceRoot: workspace,
        sessionKey: 'k',
        validity: registryView(registry, clock.now),
      })
    const writer = open()
    await writer.configure({ mode: 'auto' })
    const stored = await writer.readFile('MEMORY.md')
    await writer.editFile(
      'MEMORY.md',
      `Human line.\n\n${marked('ra000000001', 'Fresh lesson.')}\n\n${marked('rb000000001', 'Stale lesson.')}\n`,
      stored.hash,
    )
    const first = await open().snapshot(1)
    expect(first?.content).toContain('Fresh lesson.')
    expect(first?.content).not.toContain('Stale lesson.')
    expect(first?.content).toContain('[1 task-experience paragraphs omitted: expired or unverifiable]')
    // The same answers give the same revision in a later burst.
    await nextBurst()
    expect((await open().snapshot(1))?.revision).toBe(first?.revision)
    await nextBurst()
    clock.set(T0 + REVIEW_AFTER_MS)
    const later = await open().snapshot(1)
    expect(later?.content).not.toContain('Fresh lesson.')
    expect(later?.revision).not.toBe(first?.revision)
  })

  it('a file without managed paragraphs gives the same snapshot with or without the view', async () => {
    const home = scratch()
    const workspace = join(home, 'ws')
    mkdirSync(workspace)
    const clock = clockAt(T0)
    const registry = new RefinementRegistry(join(home, 'data'), workspace, clock.now)
    seed(registry, [paragraph('ra000000001', T0)])
    const plain = provider().open({ home, workspaceRoot: workspace, sessionKey: 'k' })
    await plain.configure({ mode: 'auto' })
    const stored = await plain.readFile('MEMORY.md')
    await plain.editFile('MEMORY.md', 'Prefer short answers.\n', stored.hash)
    const read = vi.spyOn(registry, 'read')
    const withView = await provider()
      .open({ home, workspaceRoot: workspace, sessionKey: 'k', validity: registryView(registry, clock.now) })
      .snapshot(1)
    const without = await provider().open({ home, workspaceRoot: workspace, sessionKey: 'k' }).snapshot(1)
    expect(withView?.content).toContain('Prefer short answers.')
    expect(withView).toEqual(without)
    // Nothing in the file is managed, so the registry is never consulted.
    expect(read).not.toHaveBeenCalled()
  })
})

describe('changes of the view a session reads', () => {
  it('reports when its answers change, never on the first read, and only while refinement is on', async () => {
    const dataDir = scratch()
    const clock = clockAt(T0)
    const registry = new RefinementRegistry(dataDir, '/ws', clock.now)
    seed(registry, [paragraph('ra000000001', T0), paragraph('rb000000001', T0 - REVIEW_AFTER_MS / 2)])
    const heard: unknown[] = []
    const view = registryView(registry, clock.now, (change) => heard.push(change))
    view.revision()
    await nextBurst()
    expect(heard).toEqual([])
    // Nothing moved: the same answers say nothing.
    view.validity('ra000000001')
    await nextBurst()
    expect(heard).toEqual([])
    clock.set(T0 + REVIEW_AFTER_MS / 2 + 1)
    view.revision()
    await nextBurst()
    expect(heard).toEqual([{ inForce: 1, expired: 1 }])

    const { workspaceMemory } = await import('../../src/runtime/refinement/workspace-memory.js')
    const reported: string[] = []
    let enabled = false
    const memory = workspaceMemory({
      dataDir,
      clock: clock.now,
      enabled: () => enabled,
      viewChanged: (key) => reported.push(key),
    })
    const sessionView = memory.validity('/ws', 'session-1')
    sessionView.revision()
    await nextBurst()
    clock.set(T0 + REVIEW_AFTER_MS + 1)
    sessionView.revision()
    await nextBurst()
    expect(reported).toEqual([])
    enabled = true
    registry.renew({ paragraphId: 'ra000000001' })
    sessionView.revision()
    await nextBurst()
    expect(reported).toEqual(['session-1'])
    // A view opened for work outside any session reports nothing.
    const background = memory.validity('/ws')
    background.revision()
    await nextBurst()
    clock.set(T0 + 3 * REVIEW_AFTER_MS)
    background.revision()
    await nextBurst()
    expect(reported).toEqual(['session-1'])
  })
})

describe('the views sessions open memory with', () => {
  it('a child session sees saved paragraphs in its memory note; other sessions get them delivered', async () => {
    const { workspaceMemory } = await import('../../src/runtime/refinement/workspace-memory.js')
    const { userMemory } = await import('../../src/runtime/refinement/user-memory.js')
    const dataDir = scratch()
    const home = scratch()
    const clock = () => T0
    const memory = workspaceMemory({ dataDir, clock, enabled: () => true })
    const registry = memory.registry('/ws')
    seed(registry, [paragraph('ra000000001', T0)])
    expect(memory.validity('/ws', 'main').validity('ra000000001')).toBe('delivered')
    expect(memory.validity('/ws', 'child', true).validity('ra000000001')).toBe('valid')
    const user = userMemory({
      home,
      clock,
      settings: () => ({ enabled: true, mode: 'auto', revision: 'r' }) as never,
      saves: { save: async () => ({}) } as never,
      registry: memory.registry,
      memory: () => undefined,
      workspaceParagraphs: (async () => ({ paragraphs: [] })) as never,
      viewChanged: () => undefined,
    })
    const users = user.userRegistry()
    seed(users, [paragraph('rb000000001', T0)])
    expect(user.userValidity('main').validity('rb000000001')).toBe('delivered')
    expect(user.userValidity('child', true).validity('rb000000001')).toBe('valid')
  })
})
