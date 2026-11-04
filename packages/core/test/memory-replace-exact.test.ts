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
})
