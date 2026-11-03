import { describe, expect, it } from 'vitest'
import {
  type MemoryFilePort,
  type MemoryParagraph,
  type MemoryParagraphChange,
  type MemoryParagraphPort,
  type MemoryParagraphValidity,
  type MemoryProvider,
  type MemorySession,
  type MemorySource,
  type MemoryValidityView,
  memoryKind,
  type ToolContext,
} from '../src/index.js'

// A session written against the contract before the optional validity view, paragraph port and
// exact replacement existed. It must keep compiling and keep being accepted unchanged.
function legacySession(root: string): MemorySession {
  return {
    root,
    snapshot: async () => undefined,
    files: (fallback) => fallback,
    inspect: async () => {
      throw new Error('not used')
    },
    configure: async () => {
      throw new Error('not used')
    },
    readFile: async () => {
      throw new Error('not used')
    },
    editFile: async () => {
      throw new Error('not used')
    },
  }
}

// The same, written as a class, and a provider that wraps another one, as 5.1.0 authors wrote them.
class LegacyClassSession implements MemorySession {
  constructor(readonly root: string) {}
  async snapshot() {
    return undefined
  }
  files(fallback: MemoryFilePort) {
    return fallback
  }
  inspect(): ReturnType<MemorySession['inspect']> {
    throw new Error('not used')
  }
  configure(): ReturnType<MemorySession['configure']> {
    throw new Error('not used')
  }
  readFile(): ReturnType<MemorySession['readFile']> {
    throw new Error('not used')
  }
  editFile(): ReturnType<MemorySession['editFile']> {
    throw new Error('not used')
  }
}
function wrapping(inner: MemoryProvider): MemoryProvider {
  return {
    id: 'wrapper',
    version: '1.0.0',
    open: ({ home, workspaceRoot, sessionKey }) => inner.open({ home, workspaceRoot, sessionKey }),
  }
}

const legacyFiles: MemoryFilePort = {
  read: async () => new Uint8Array(),
  write: async () => {},
  list: async () => [],
  stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
}

describe('memory provider contract', () => {
  it('a provider without validity or paragraphs still validates as a memory provider', () => {
    const provider: MemoryProvider = {
      id: 'legacy',
      version: '1.0.0',
      open: (input) => legacySession(input.workspaceRoot),
    }
    expect(() => memoryKind.validate(provider)).not.toThrow()
    const session = provider.open({ home: '/home', workspaceRoot: '/ws', sessionKey: 's' })
    expect(session.paragraphs).toBeUndefined()
    expect(legacyFiles.replaceExact).toBeUndefined()
    const classic: MemoryProvider = wrapping({
      id: 'classic',
      version: '1.0.0',
      open: (input) => new LegacyClassSession(input.workspaceRoot),
    })
    expect(() => memoryKind.validate(classic)).not.toThrow()
    const opened = classic.open({ home: '/home', workspaceRoot: '/ws', sessionKey: 's' })
    expect(opened.root).toBe('/ws')
    expect(opened.paragraphs).toBeUndefined()
  })

  it('open accepts an input with validity and an old provider ignores it', () => {
    const seen: unknown[] = []
    // The pre-existing parameter shape stays assignable to the provider contract.
    const legacyOpen = (input: Readonly<{ home: string; workspaceRoot: string; sessionKey: string }>) => {
      seen.push(Object.keys(input).sort())
      return legacySession(input.workspaceRoot)
    }
    const legacy: MemoryProvider = { id: 'legacy', version: '1.0.0', open: legacyOpen }
    const view: MemoryValidityView = { revision: () => 'r1', validity: () => 'unknown' }
    const session = legacy.open({ home: '/home', workspaceRoot: '/ws', sessionKey: 's', validity: view })
    expect(session.root).toBe('/ws')
    expect(seen).toEqual([['home', 'sessionKey', 'validity', 'workspaceRoot']])

    // A provider that implements the paragraph port reads the view it was given.
    const paragraphs: MemoryParagraph[] = []
    const aware: MemoryProvider = {
      id: 'aware',
      version: '1.0.0',
      open: (input) => ({
        ...legacySession(input.workspaceRoot),
        paragraphs: (source: MemorySource, signal: AbortSignal): MemoryParagraphPort => {
          void source
          void signal
          return {
            list: async () => ({ hash: 'a'.repeat(64), paragraphs }),
            propose: async (
              changes: MemoryParagraphChange | readonly MemoryParagraphChange[],
              baseHash?: string,
            ) => ({
              path: 'MEMORY.md',
              baseHash: baseHash ?? 'a'.repeat(64),
              newHash: 'b'.repeat(64),
              diff: (Array.isArray(changes) ? changes : [changes]).map((change) => change.op).join(','),
              source,
            }),
            commit: async (proposal) => ({ hash: proposal.newHash }),
          }
        },
      }),
    }
    const validity: MemoryParagraphValidity = view.validity('r0000000001')
    paragraphs.push({ id: 'r0000000001', text: 'note', validity })
    const opened = aware.open({ home: '/home', workspaceRoot: '/ws', sessionKey: 's', validity: view })
    expect(typeof opened.paragraphs).toBe('function')
  })

  it('maintenance is an optional source field and exact replacement is optional on both file ports', () => {
    const turnSource: MemorySource = { sessionKey: 's', turn: 1 }
    const maintenance: MemorySource = { sessionKey: 's', turn: 3, maintenance: 'run-1' }
    expect(turnSource.maintenance).toBeUndefined()
    expect(maintenance.maintenance).toBe('run-1')
    const replacing: MemoryFilePort = { ...legacyFiles, replaceExact: async () => {} }
    // The memory file port is handed to tools as their filesystem, so the two must stay assignable.
    const fs: ToolContext['fs'] = replacing
    expect(typeof fs.replaceExact).toBe('function')
  })
})
