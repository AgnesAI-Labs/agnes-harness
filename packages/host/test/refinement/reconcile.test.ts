import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPlugin } from '@agnes/base'
import type { MemoryProvider, MemorySession } from '@agnes/extension-api'
import {
  normalizedContentHash,
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistryParagraph,
} from '@agnes/host-infrastructure/refinement-registry'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRefinementHost } from '../../src/runtime/assemble/refinement.js'
import {
  paragraphPortOf,
  reconcileWorkspace,
  WORKSPACE_MEMORY_KEY,
} from '../../src/runtime/refinement/reconcile.js'
import { registryView } from '../../src/runtime/refinement/registry-view.js'
import { workspaceMemory } from '../../src/runtime/refinement/workspace-memory.js'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-reconcile-'))
  dirs.push(dir)
  return dir
}

const T0 = Date.UTC(2026, 10, 4)
const clock = () => T0
const A = 'ra000000001'
const B = 'rb000000001'
const LESSON = 'Run the linter before committing.\nIt catches import order.'
const source = (entryId: string) => ({
  sessionKey: 'session-1',
  kind: 'memory' as const,
  entryId,
  contentHash: normalizedContentHash(`entry ${entryId}`),
  initiator: 'auto' as const,
})
const paragraph = (id: string, text: string): RegistryParagraph => ({
  id,
  source: source(`entry-${id}`),
  contentHash: normalizedContentHash(text),
  reviewAfter: T0 + REVIEW_AFTER_MS,
  state: 'active',
  fileHash: 'f',
})
const marked = (id: string, text: string) => `<!-- refinement:${id} -->\n${text}\n<!-- /refinement:${id} -->`

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

/** A workspace with a registry and the bundled file memory, opened the way the Host opens it. */
function workspace() {
  const home = scratch()
  const root = join(home, 'ws')
  mkdirSync(root)
  const dataDir = join(home, 'data')
  const registry = new RefinementRegistry(dataDir, root, clock)
  const open = (sessionKey = WORKSPACE_MEMORY_KEY) =>
    provider().open({ home, workspaceRoot: root, sessionKey, validity: registryView(registry, clock) })
  const write = async (content: string) => {
    const memory = open()
    const stored = await memory.readFile('MEMORY.md')
    await memory.editFile('MEMORY.md', content, stored.hash)
  }
  const seed = (...paragraphs: RegistryParagraph[]) =>
    registry.update((draft) => {
      draft.paragraphs.push(...paragraphs)
    }, registry.read().revision)
  const stateOf = (id: string) => registry.read().paragraphs.find((entry) => entry.id === id)?.state
  return { home, root, dataDir, registry, open, write, seed, stateOf }
}

describe('reconciling saved paragraphs with the memory file', () => {
  it('a paragraph the user deleted becomes a memory-deleted revocation', async () => {
    const ws = workspace()
    ws.seed(paragraph(A, LESSON), paragraph(B, 'Keep answers short.'))
    await ws.write(`Human line.\n\n${marked(A, LESSON)}\n\n${marked(B, 'Keep answers short.')}\n`)
    // The person deletes paragraph A, markers and all.
    await ws.write(`Human line.\n\n${marked(B, 'Keep answers short.')}\n`)
    const revocations = await reconcileWorkspace(ws.registry, ws.open(), clock)
    expect(revocations).toEqual([
      {
        sessionKey: 'session-1',
        kind: 'memory',
        entryId: `entry-${A}`,
        contentHash: source(`entry-${A}`).contentHash,
        action: 'memory-deleted',
        at: T0,
      },
    ])
    expect(ws.stateOf(A)).toBe('removed')
    expect(ws.stateOf(B)).toBe('active')
    // The same content may no longer be saved again automatically, under any entry id.
    expect(
      ws.registry.revoked({ ...source('another-id'), contentHash: source(`entry-${A}`).contentHash }),
    ).toMatchObject({
      action: 'memory-deleted',
    })
    // A second pass finds nothing more to do.
    expect(await reconcileWorkspace(ws.registry, ws.open(), clock)).toEqual([])
    expect(ws.registry.read().revocations).toHaveLength(1)
  })

  it('markers removed by a person with the text kept mark the paragraph converted', async () => {
    const ws = workspace()
    ws.seed(paragraph(A, LESSON))
    await ws.write(`Human line.\n\n${marked(A, LESSON)}\n`)
    // The person drops the markers and reflows the text a little: it is now ordinary memory.
    await ws.write(
      'Human line.\n\n  Run the linter   before committing.\nIt catches import order.\n\nMore.\n',
    )
    expect(await reconcileWorkspace(ws.registry, ws.open(), clock)).toEqual([])
    expect(ws.stateOf(A)).toBe('converted')
    expect(ws.registry.read().revocations).toEqual([])
    // A converted paragraph is no longer managed: the view no longer vouches for its id.
    expect(registryView(ws.registry, clock).validity(A)).toBe('unknown')
  })

  it('damaged markers are left for repair and never read as a deletion', async () => {
    const ws = workspace()
    ws.seed(paragraph(A, LESSON))
    await ws.write(`Human line.\n\n<!-- refinement:${A} -->\n${LESSON}\n`)
    const before = ws.registry.read().revision
    expect(await reconcileWorkspace(ws.registry, ws.open(), clock)).toEqual([])
    expect(ws.stateOf(A)).toBe('active')
    expect(ws.registry.read().revision).toBe(before)
  })

  it('a save still in flight is left alone', async () => {
    const ws = workspace()
    ws.seed(paragraph(A, LESSON))
    ws.registry.update((draft) => {
      draft.receipts.push({
        receiptId: 'r1',
        commandId: 'c1',
        initiator: 'auto',
        source: source(`entry-${A}`),
        outcome: 'unknown',
        steps: [],
        target: { kind: 'memory-paragraph', paragraphId: A, fileHash: 'f' },
        at: T0,
      })
    }, ws.registry.read().revision)
    await ws.write('Human line.\n')
    expect(await reconcileWorkspace(ws.registry, ws.open(), clock)).toEqual([])
    expect(ws.stateOf(A)).toBe('active')
  })

  it('a registry that cannot be believed is never written', async () => {
    const ws = workspace()
    ws.seed(paragraph(A, LESSON))
    await ws.write('Human line.\n')
    const dir = join(ws.dataDir, 'refinement', 'workspaces')
    const file = readdirSync(dir).find((name) => name.endsWith('.json'))
    if (!file) throw new Error('registry file missing')
    writeFileSync(join(dir, file), '{"version":1')
    const mtime = statSync(join(dir, file)).mtimeMs
    expect(await reconcileWorkspace(ws.registry, ws.open(), clock)).toEqual([])
    expect(statSync(join(dir, file)).mtimeMs).toBe(mtime)
    expect(registryView(ws.registry, clock).validity(A)).toBe('unknown')
  })

  it('a registry changed meanwhile is read again with the file before anything is written', async () => {
    const ws = workspace()
    ws.seed(paragraph(A, LESSON))
    await ws.write('Human line.\n')
    const session = ws.open()
    const readFile = session.readFile.bind(session)
    let raced = false
    // While the first pass reads the file, a save lands paragraph B in the file and then in the registry.
    const racing: MemorySession = {
      ...session,
      readFile: async (path) => {
        const before = await readFile(path)
        if (!raced) {
          raced = true
          await ws.write(`Human line.\n\n${marked(B, 'Keep answers short.')}\n`)
          ws.seed(paragraph(B, 'Keep answers short.'))
        }
        return before
      },
    }
    const revocations = await reconcileWorkspace(ws.registry, racing, clock)
    expect(raced).toBe(true)
    expect(revocations.map((entry) => entry.entryId)).toEqual([`entry-${A}`])
    expect(ws.stateOf(A)).toBe('removed')
    expect(ws.stateOf(B)).toBe('active')
  })

  it('a provider without a working paragraph port is skipped', async () => {
    const ws = workspace()
    ws.seed(paragraph(A, LESSON))
    await ws.write('Human line.\n')
    const session = ws.open()
    const before = ws.registry.read().revision
    const { paragraphs: _unused, ...withoutPort } = session
    const variants: MemorySession[] = [
      withoutPort,
      // A 5.1.0 session class may have a member of that name that is something else entirely.
      { ...session, paragraphs: 'not a port' as never },
      {
        ...session,
        paragraphs: () => {
          throw new Error('no')
        },
      },
      { ...session, paragraphs: () => ({ list: 'nope' }) as never },
      {
        ...session,
        paragraphs: () =>
          ({
            list: async () => ({ paragraphs: 'nope' }),
            propose: async () => ({}),
            commit: async () => ({}),
          }) as never,
      },
    ]
    for (const variant of variants) {
      expect(await reconcileWorkspace(ws.registry, variant, clock)).toEqual([])
    }
    expect(ws.registry.read().revision).toBe(before)
    expect(
      paragraphPortOf(
        { ...session, paragraphs: 'x' as never },
        { sessionKey: 'k', turn: 0 },
        new AbortController().signal,
      ),
    ).toBeUndefined()
    expect(paragraphPortOf(session, { sessionKey: 'k', turn: 0 }, new AbortController().signal)).toBeDefined()
  })
})

describe('reconciling when a session opens', () => {
  const enable = (dataDir: string, enabled: boolean) => {
    const store = new RefinementSettingsStore(dataDir, 'p')
    store.save({ enabled, mode: 'auto' }, store.read().revision)
  }

  it('with refinement off no registry is read or written', async () => {
    const ws = workspace()
    ws.seed(paragraph(A, LESSON))
    await ws.write('Human line.\n')
    const file = join(ws.dataDir, 'refinement', 'workspaces')
    const [name] = readdirSync(file)
    if (!name) throw new Error('registry file missing')
    const mtime = statSync(join(file, name)).mtimeMs
    const read = vi.spyOn(RefinementRegistry.prototype, 'read')
    const opener = vi.fn(ws.open)
    const off = workspaceMemory({ dataDir: ws.dataDir, clock, enabled: () => false })
    off.bindMemory((_root, key) => opener(key))
    const session = ws.open('session-2')
    expect(off.opened(ws.root, session)).toBe(session)
    expect(await off.reconcile(ws.root)).toEqual([])
    expect(opener).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(statSync(join(file, name)).mtimeMs).toBe(mtime)
    expect(ws.stateOf(A)).toBe('active')
  })

  it('a workspace that never saved anything has no registry file after a session opens', async () => {
    const dataDir = scratch()
    enable(dataDir, true)
    const host = createRefinementHost(dataDir, 'p', clock)
    const opener = vi.fn(() => undefined)
    host.workspace.bindMemory(opener)
    host.workspace.opened('/never-saved', undefined)
    expect(await host.workspace.reconcile('/never-saved')).toEqual([])
    // Nothing to reconcile, so memory was not even opened.
    expect(opener).not.toHaveBeenCalled()
    expect(() => readdirSync(join(dataDir, 'refinement', 'workspaces'))).toThrow()
  })

  it('with refinement on, opening a session reconciles its workspace once at a time', async () => {
    const ws = workspace()
    enable(ws.dataDir, true)
    ws.seed(paragraph(A, LESSON))
    await ws.write('Human line.\n')
    const host = createRefinementHost(ws.dataDir, 'p', clock)
    const opener = vi.fn((_root: string, key: string) => ws.open(key))
    host.workspace.bindMemory(opener)
    host.workspace.opened(ws.root, ws.open('session-2'))
    const second = host.workspace.reconcile(ws.root)
    expect((await second).map((entry) => entry.action)).toEqual(['memory-deleted'])
    expect(opener).toHaveBeenCalledTimes(1)
    expect(opener).toHaveBeenCalledWith(ws.root, WORKSPACE_MEMORY_KEY)
    expect(ws.stateOf(A)).toBe('removed')
    // The workspace memory the Host opens for background work is the same provider, keyed for the workspace.
    expect(host.workspace.openWorkspaceMemory(ws.root)).toBeDefined()
    // Switching refinement off stops it.
    enable(ws.dataDir, false)
    ws.seed(paragraph(B, 'Keep answers short.'))
    expect(await host.workspace.reconcile(ws.root)).toEqual([])
    expect(ws.stateOf(B)).toBe('active')
  })
})
