import type { ChildTaskRecord } from '@agnes/extension-api'
import { defineAgnesPlugin } from '@agnes/plugin-runtime'
import { describe, expect, it } from 'vitest'
import {
  childControlWorktreePersist,
  ecosystemInitFor,
  mountEcosystem,
  readSubagentLimits,
} from '../src/ecosystem.js'
import type { SeamInitContext } from '../src/seam-init.js'

describe('subagent ecosystem policy', () => {
  it('maps the resolved preset spelling to tool limits', () => {
    expect(
      readSubagentLimits({
        subagent: { max_depth: 2, max_fan_out: 7, isolation: 'worktree' },
      }),
    ).toEqual({ maxDepth: 2, maxFanOut: 7, isolation: 'worktree' })
  })

  it.each([
    [{}, 'missing subagent policy'],
    [{ subagent: { max_depth: -1, max_fan_out: 1, isolation: 'shared' } }, 'max_depth'],
    [{ subagent: { max_depth: 1, max_fan_out: 1.5, isolation: 'shared' } }, 'max_fan_out'],
    [{ subagent: { max_depth: 1, max_fan_out: 2, isolation: 'remote' } }, 'isolation'],
  ])('refuses malformed policy %#', (preset, message) => {
    expect(() => readSubagentLimits(preset)).toThrow(message)
  })
})

describe('subagent worktree persistence', () => {
  const entry = {
    root: '/work/proj',
    path: '/work/proj/.worktrees/agnes-1',
    branch: 'agnes/subagent-1',
    stage: 'attached' as const,
  }
  it('binds through the child-control port by the child workspace id', async () => {
    const calls: unknown[] = []
    const persist = childControlWorktreePersist({
      lookupByKey: async (key) => (key === 'child' ? ({ workspaceId: 'ws:child' } as ChildTaskRecord) : null),
      updateWorkspace: async (id, patch) => {
        calls.push([id, patch])
      },
    })
    await persist.bind('child', entry)
    expect(calls).toEqual([
      ['ws:child', { phase: 'attached', path: entry.path, root: entry.root, branch: entry.branch }],
    ])
    expect(persist.load()).toEqual(new Map())
    await expect(persist.bind('unknown', entry)).rejects.toThrow(
      'worktree binding requires a child workspace',
    )
    expect(calls).toHaveLength(1)
  })
  it('refuses a child without a workspace', async () => {
    const persist = childControlWorktreePersist({
      lookupByKey: async () => ({ workspaceId: null }) as ChildTaskRecord,
      updateWorkspace: async () => undefined,
    })
    await expect(persist.bind('child', entry)).rejects.toThrow('worktree binding requires a child workspace')
  })
  it('refuses to bind without the Host child-control port', async () => {
    await expect(childControlWorktreePersist(undefined).bind('child', entry)).rejects.toThrow(
      'worktree isolation requires the Host child-control port',
    )
  })
})

describe('child-control port narrowing', () => {
  const port = { lookupByKey: async () => null, updateWorkspace: async () => undefined }
  const init = { childControl: port, secrets: () => '' } as unknown as SeamInitContext
  it('forwards the Host port only to agnes/subagent', () => {
    expect(ecosystemInitFor('agnes/subagent', init).childControl).toBe(port)
    for (const id of ['agnes/refine', 'agnes/hooks-runner', 'agnes/privacy', 'agnes/skills']) {
      const narrowed = ecosystemInitFor(id, init)
      expect(narrowed.childControl).toBeUndefined()
      expect('childControl' in narrowed).toBe(false)
      expect(narrowed.secrets).toBe(init.secrets)
    }
  })
  it('passes a context without the port through unchanged', () => {
    const bare = { secrets: () => '' } as unknown as SeamInitContext
    expect(ecosystemInitFor('agnes/refine', bare)).toBe(bare)
  })
})

describe('mountEcosystem', () => {
  it('narrows the context of every mounted factory, so only agnes/subagent receives the port', () => {
    const port = { lookupByKey: async () => null, updateWorkspace: async () => undefined }
    const init = { childControl: port, secrets: () => '' } as unknown as SeamInitContext
    const seen = new Map<string, SeamInitContext>()
    const plugin = defineAgnesPlugin({ apply: () => undefined })
    const recording = (id: string) => (context: SeamInitContext) => {
      seen.set(id, context)
      return plugin
    }
    const mounted = mountEcosystem({
      'agnes/subagent': recording('agnes/subagent'),
      'agnes/refine': recording('agnes/refine'),
    })
    expect(typeof mounted['agnes/subagent'](init)).toBe('function')
    expect(typeof mounted['agnes/refine'](init)).toBe('function')
    expect(seen.get('agnes/subagent')?.childControl).toBe(port)
    expect(seen.get('agnes/refine')).toBeDefined()
    expect('childControl' in (seen.get('agnes/refine') as object)).toBe(false)
    expect(seen.get('agnes/refine')?.secrets).toBe(init.secrets)
  })
})
