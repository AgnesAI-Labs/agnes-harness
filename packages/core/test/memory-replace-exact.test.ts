import type { MemoryFilePort, MemorySession, ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

const parameters = Type.Object({})
const MEMORY = '/w/memory/MEMORY.md'

function memoryTool(execute: ToolDef<typeof parameters>['execute']): ToolDef<typeof parameters> {
  return {
    name: 'memory_editor',
    description: 'synthetic memory editor',
    parameters,
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'never',
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: 'never',
    },
    execute,
  }
}

function memorySession(withReplace: boolean, replaced: unknown[]): MemorySession {
  return {
    root: '/w/memory',
    snapshot: async () => undefined,
    files: (fallback, source, _signal, approve): MemoryFilePort => ({
      ...fallback,
      ...(withReplace
        ? {
            async replaceExact(path: string, oldText: string, newText: string) {
              const answer = await approve({
                path,
                baseHash: '0'.repeat(64),
                newHash: '1'.repeat(64),
                diff: `-${oldText}\n+${newText}`,
                source,
              })
              if (answer.status !== 'approved')
                throw Object.assign(new Error('provider rejected'), { code: 'MEMORY_APPROVAL_REJECTED' })
              replaced.push([path, oldText, newText])
            },
          }
        : {}),
    }),
    inspect: async () => {
      throw new Error('unused')
    },
    configure: async () => {
      throw new Error('unused')
    },
    readFile: async () => {
      throw new Error('unused')
    },
    editFile: async () => {
      throw new Error('unused')
    },
  }
}

async function runTool(memory: MemorySession | undefined, approved: boolean) {
  const seen: { present?: boolean } = {}
  const registry = new ToolRegistry()
  registry.add(
    memoryTool(async (_args, ctx) => {
      seen.present = typeof ctx.fs.replaceExact === 'function'
      if (ctx.fs.replaceExact) await ctx.fs.replaceExact(MEMORY, 'old line', 'new line')
      return { content: [{ type: 'text', text: 'done' }] }
    }),
    { source: 'fixture/memory-editor', trust: 'builtin' },
  )
  const seams = fakeSeams({
    approval: {
      ask: async (request) =>
        request.scope?.startsWith('memory:') && approved
          ? { verdict: 'allowed-once', answeredBy: actor }
          : { verdict: 'rejected', answeredBy: actor },
    },
  })
  const opened = await openSession({
    ...(memory ? { memory } : {}),
    registry,
    seams,
    provider: fakeProvider([toolTurn('memory_editor', {}), textTurn('ok')]),
  })
  try {
    await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    await opened.session.run({ until: 'turn-end', signal: new AbortController().signal })
    const rows = await opened.log.scan({ fromSeq: 1, toSeq: opened.log.lastSeq })
    return { seen, result: rows.find((row) => row.type === 'tool/result')?.data }
  } finally {
    await opened.session.close()
  }
}

async function runWriteOrRecall(options: { writeErrorCode?: string; withRecall?: boolean; query?: string }) {
  const seen: { hasMemory?: boolean; recallResult?: unknown } = {}
  const memory: MemorySession = {
    root: '/w/memory',
    snapshot: async () => undefined,
    files: (fallback): MemoryFilePort => ({
      ...fallback,
      write: async () => {
        if (options.writeErrorCode) {
          throw Object.assign(new Error(options.writeErrorCode), { code: options.writeErrorCode })
        }
      },
      ...(options.withRecall
        ? {
            recall: async (query) => ({
              revision: 'rev-r0',
              hits: [
                {
                  layer: 'workspace' as const,
                  path: 'MEMORY.md',
                  lineStart: 3,
                  lineEnd: 4,
                  text: `hit:${query.query}`,
                  score: 1,
                },
              ],
              truncated: false,
            }),
          }
        : {}),
    }),
    inspect: async () => {
      throw new Error('unused')
    },
    configure: async () => {
      throw new Error('unused')
    },
    readFile: async () => {
      throw new Error('unused')
    },
    editFile: async () => {
      throw new Error('unused')
    },
  }
  const registry = new ToolRegistry()
  registry.add(
    memoryTool(async (_args, ctx) => {
      seen.hasMemory = ctx.memory !== undefined
      if (options.query !== undefined && ctx.memory) {
        seen.recallResult = await ctx.memory.recall({ query: options.query })
      }
      if (options.writeErrorCode) await ctx.fs.write(MEMORY, 'next')
      return { content: [{ type: 'text', text: 'done' }] }
    }),
    { source: 'fixture/memory-editor', trust: 'builtin' },
  )
  const opened = await openSession({
    memory,
    registry,
    seams: fakeSeams(),
    provider: fakeProvider([toolTurn('memory_editor', {}), textTurn('ok')]),
  })
  try {
    await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    await opened.session.run({ until: 'turn-end', signal: new AbortController().signal })
    const rows = await opened.log.scan({ fromSeq: 1, toSeq: opened.log.lastSeq })
    return {
      seen,
      result: rows.find((row) => row.type === 'tool/result')?.data,
      runState: opened.session.state,
    }
  } finally {
    await opened.session.close()
  }
}

describe('ToolContext.fs.replaceExact', () => {
  it('reaches the memory port when the port offers it', async () => {
    const replaced: unknown[] = []
    const { seen, result } = await runTool(memorySession(true, replaced), true)
    expect(seen.present).toBe(true)
    expect(replaced).toEqual([[MEMORY, 'old line', 'new line']])
    expect(result).not.toMatchObject({ isError: true })
  })

  it('is absent when the memory port lacks it and when no memory is selected', async () => {
    const replaced: unknown[] = []
    expect((await runTool(memorySession(false, replaced), true)).seen.present).toBe(false)
    expect((await runTool(undefined, true)).seen.present).toBe(false)
    expect(replaced).toEqual([])
  })

  it('counts as a write, so a refused approval proves nothing was changed', async () => {
    const replaced: unknown[] = []
    const { result } = await runTool(memorySession(true, replaced), false)
    expect(replaced).toEqual([])
    expect(result).toMatchObject({
      isError: true,
      code: 'TOOL_REJECTED_BEFORE_EFFECT',
      structured: { effect: 'none', code: 'MEMORY_APPROVAL_REJECTED' },
    })
  })

  it.each(['MEMORY_HUMAN_EDITED', 'MEMORY_PARAGRAPH_EDITED', 'MEMORY_PREFERENCE_CONFLICT'])(
    'treats %s as a pre-effect refusal without parking the session',
    async (code) => {
      const { result, runState } = await runWriteOrRecall({ writeErrorCode: code })
      expect(result).toMatchObject({
        isError: true,
        code: 'TOOL_REJECTED_BEFORE_EFFECT',
        structured: { effect: 'none', code },
      })
      expect(runState).not.toBe('parked')
    },
  )

  it('exposes ToolContext.memory only when the provider file port supplies recall', async () => {
    const without = await runWriteOrRecall({ withRecall: false })
    expect(without.seen.hasMemory).toBe(false)
    const withRecall = await runWriteOrRecall({ withRecall: true, query: 'pnpm' })
    expect(withRecall.seen.hasMemory).toBe(true)
    expect(withRecall.seen.recallResult).toMatchObject({
      revision: 'rev-r0',
      hits: [{ path: 'MEMORY.md', lineStart: 3, lineEnd: 4, text: 'hit:pnpm' }],
    })
  })
})
