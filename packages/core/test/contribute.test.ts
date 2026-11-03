import type { ToolDef } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { mergeContributions } from '../src/request/contribute.js'

const meta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe' as const,
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: undefined,
}
const def = (name: string): ToolDef =>
  ({
    name,
    description: 'd',
    parameters: { type: 'object' },
    meta,
    execute: async () => ({ content: [] }),
  }) as unknown as ToolDef

const registry = (...names: string[]) => {
  const r = new ToolRegistry()
  for (const n of names) r.add(def(n), { source: 's', trust: 'builtin' })
  return r.snapshot(1)
}

describe('mergeContributions', () => {
  it('unions tools within the snapshot, orders sections, deep-merges runtime context and records conflicts', () => {
    const out = mergeContributions(
      [
        {
          op: 'tools-core',
          tools: ['shell', 'read', 'ghost'],
          promptSections: [{ id: 'env', order: 110, text: 'E', source: 'tools-core' }],
          runtimeContext: { cwd: '/a', git: { branch: 'main' } },
        },
        {
          op: 'code',
          tools: ['read'],
          promptSections: [
            { id: 'persona', order: 100, text: 'P', source: 'code' },
            { id: 'doc', order: 110, text: 'D', source: 'code' },
          ],
          runtimeContext: { git: { dirty: true, branch: 'dev' } },
        },
      ],
      registry('read', 'shell'),
    )
    // 'ghost' is not in the snapshot, so it is not offered.
    expect(out.tools).toEqual(['read', 'shell'])
    expect(out.sections.map((s) => s.id)).toEqual(['persona', 'doc', 'env'])
    expect(out.runtimeContext).toEqual({ cwd: '/a', git: { branch: 'dev', dirty: true } })
    // Ownership is per leaf: the first op wrote the whole `git` block, so it owns `git.branch` and
    // the second op writing that leaf is the conflict. `cwd` and `git.dirty` have one owner each.
    expect(out.conflicts).toEqual([{ key: 'git.branch', ops: ['tools-core', 'code'] }])
  })

  it('leaves the contributions it was given untouched', () => {
    const rc = { git: { branch: 'main' } }
    const first = { op: 'a', runtimeContext: rc }
    const out = mergeContributions(
      [first, { op: 'b', runtimeContext: { git: { branch: 'dev' } } }],
      registry(),
    )
    expect(rc).toEqual({ git: { branch: 'main' } })
    expect(out.runtimeContext.git).not.toBe(rc.git)
  })

  it('records a conflict when a block and a scalar collide at the same path, in either order', () => {
    // Neither direction can be caught leaf by leaf: the scalar owns no leaf under the path, and the
    // block's leaves are discarded wholesale by the scalar.
    const blockOverScalar = mergeContributions(
      [
        { op: 'a', runtimeContext: { git: 'main' } },
        { op: 'b', runtimeContext: { git: { branch: 'dev' } } },
      ],
      registry(),
    )
    expect(blockOverScalar.conflicts).toEqual([{ key: 'git', ops: ['a', 'b'] }])
    expect(blockOverScalar.runtimeContext).toEqual({ git: { branch: 'dev' } })

    const scalarOverBlock = mergeContributions(
      [
        { op: 'a', runtimeContext: { git: { branch: 'dev' } } },
        { op: 'b', runtimeContext: { git: 'main' } },
      ],
      registry(),
    )
    expect(scalarOverBlock.conflicts).toEqual([{ key: 'git', ops: ['a', 'b'] }])
    expect(scalarOverBlock.runtimeContext).toEqual({ git: 'main' })

    // And the stale ownership either leaves behind must not resurface as a phantom conflict when a
    // third op writes the path again.
    const third = mergeContributions(
      [
        { op: 'a', runtimeContext: { git: { branch: 'dev' } } },
        { op: 'a', runtimeContext: { git: 'main' } },
        { op: 'a', runtimeContext: { git: { branch: 'x' } } },
      ],
      registry(),
    )
    expect(third.conflicts).toEqual([])
  })

  it('forgets a whole stale subtree, so a three-level owner cannot join a later conflict', () => {
    // Three levels, because two cannot tell the difference: at two levels the conflict set at the
    // key has already accumulated the same op, and dropping the leaf branch's forgetSubtree is
    // invisible. Here op1 owns `a.b.c`; op2's scalar at `a.b` discards it, and op3's scalar at `a`
    // discards what op2 wrote. op1 is not a party to the conflict at `a` — its leaf was already
    // gone — and would only appear because ownersAt('a') still found the stale `a.b.c` entry.
    const out = mergeContributions(
      [
        { op: 'op1', runtimeContext: { a: { b: { c: 1 } } } },
        { op: 'op2', runtimeContext: { a: { b: 'x' } } },
        { op: 'op3', runtimeContext: { a: 'z' } },
      ],
      registry(),
    )
    expect(out.runtimeContext).toEqual({ a: 'z' })
    expect(out.conflicts).toEqual([
      { key: 'a.b', ops: ['op1', 'op2'] },
      { key: 'a', ops: ['op2', 'op3'] },
    ])
  })

  it('does not call one op conflicting with itself, and treats an array as a leaf', () => {
    const out = mergeContributions(
      [
        { op: 'a', runtimeContext: { list: [1, 2], n: 1 } },
        { op: 'a', runtimeContext: { list: [3], n: 2 } },
        { op: 'b', runtimeContext: { list: [4] } },
      ],
      registry(),
    )
    expect(out.runtimeContext).toEqual({ list: [4], n: 2 })
    expect(out.conflicts).toEqual([{ key: 'list', ops: ['a', 'b'] }])
  })

  it('breaks an order tie by op name and then by the order within one op', () => {
    const out = mergeContributions(
      [
        {
          op: 'zeta',
          promptSections: [
            { id: 'z2', order: 50, text: '', source: 'zeta' },
            { id: 'z1', order: 50, text: '', source: 'zeta' },
          ],
        },
        { op: 'alpha', promptSections: [{ id: 'a1', order: 50, text: '', source: 'alpha' }] },
      ],
      registry(),
    )
    expect(out.sections.map((s) => s.id)).toEqual(['a1', 'z2', 'z1'])
  })
})

describe('refinement entries', () => {
  it('are not prompt sections: they travel as task-experience notes, never in the system prompt', async () => {
    const contribute: Record<string, unknown> = await import('../src/request/contribute.js')
    expect(Object.keys(contribute)).not.toContain('harnessSections')
  })
})
