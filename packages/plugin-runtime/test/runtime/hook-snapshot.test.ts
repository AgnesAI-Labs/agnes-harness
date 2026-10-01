import { describe, expect, it } from 'vitest'
import { AssemblyRefusal } from '../../src/runtime/cordis-adapter.js'
import {
  type HookDeclaration,
  type HookSnapshotDraft,
  normalizeHookSnapshots,
} from '../../src/runtime/hook-snapshot.js'

const DIGEST = 'a'.repeat(64)
const PROVIDER = {
  bindingId: 'binding-1',
  contract: 'agh.hooks',
  logicalName: 'default',
  providerId: 'provider-1',
} as const

function declaration(
  overrides: Partial<HookDeclaration> & Pick<HookDeclaration, 'id' | 'event'>,
): HookDeclaration {
  return {
    source: 'interceptor',
    sourceKey: `src:${overrides.id}`,
    provider: PROVIDER,
    codeDigest: DIGEST,
    execution: 'opaque',
    ...overrides,
  }
}

function ids(drafts: readonly HookSnapshotDraft[]): string[] {
  return drafts.flatMap((draft) => draft.snapshot.registrations.map((item) => item.registrationId))
}

describe('hook registration snapshots', () => {
  it('orders one event by dependency, then priority, then registration id', () => {
    const drafts = normalizeHookSnapshots({
      workspaceId: 'workspace-1',
      configRevision: 3,
      registrations: [
        declaration({ id: 'm', event: 'tool_call', priority: 1, before: ['a'] }),
        declaration({ id: 'a', event: 'tool_call', priority: 5 }),
        declaration({ id: 'b', event: 'tool_call', priority: 0 }),
      ],
    })
    expect(ids(drafts)).toEqual(['b', 'm', 'a'])
    expect(drafts[0]?.snapshot.registrations.map((item) => item.ordinal)).toEqual([0, 1, 2])
    expect(drafts[0]?.snapshot.event).toBe('tool_call')
    expect(drafts[0]?.snapshot.registrations[0]).toMatchObject({
      mode: 'serial',
      category: 'directive',
      failPolicy: 'closed',
      timeoutMs: 2000,
      replayOnResume: false,
    })
    expect(drafts[0]?.digestMaterial).toMatchObject({
      registrations: [{ phase: 'before' }, { phase: 'before' }, { phase: 'before' }],
    })
    expect(drafts[0]?.snapshot.digest).toMatch(/^[a-f0-9]{64}$/u)
    const again = normalizeHookSnapshots({
      workspaceId: 'workspace-1',
      configRevision: 3,
      registrations: [
        declaration({ id: 'b', event: 'tool_call', priority: 0 }),
        declaration({ id: 'a', event: 'tool_call', priority: 5 }),
        declaration({ id: 'm', event: 'tool_call', priority: 1, before: ['a'] }),
      ],
    })
    expect(again[0]?.snapshot.digest).toBe(drafts[0]?.snapshot.digest)
  })

  it('keeps a locked legacy sequence and refuses an edge that reverses it', () => {
    const kept = normalizeHookSnapshots({
      workspaceId: 'workspace-1',
      configRevision: 1,
      registrations: [
        declaration({ id: 'z-legacy', event: 'tool_result', source: 'legacy', sourceKey: 'legacy:z' }),
        declaration({ id: 'a-legacy', event: 'tool_result', source: 'legacy', sourceKey: 'legacy:a' }),
      ],
    })
    expect(ids(kept)).toEqual(['z-legacy', 'a-legacy'])
    expect(kept[0]?.digestMaterial).toMatchObject({ registrations: [{ phase: 'after' }, { phase: 'after' }] })
    expect(() =>
      normalizeHookSnapshots({
        workspaceId: 'workspace-1',
        configRevision: 1,
        registrations: [
          declaration({ id: 'z-legacy', event: 'tool_result', source: 'legacy', sourceKey: 'legacy:z' }),
          declaration({
            id: 'a-legacy',
            event: 'tool_result',
            source: 'legacy',
            sourceKey: 'legacy:a',
            before: ['z-legacy'],
          }),
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'order_contradiction' }))
  })

  it('refuses cycles, missing targets, cross-event edges, and duplicate identities', () => {
    expect(() =>
      normalizeHookSnapshots({
        workspaceId: 'workspace-1',
        configRevision: 1,
        registrations: [
          declaration({ id: 'a', event: 'context', before: ['b'] }),
          declaration({ id: 'b', event: 'context', before: ['a'] }),
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'dependency_cycle' }))
    expect(() =>
      normalizeHookSnapshots({
        workspaceId: 'workspace-1',
        configRevision: 1,
        registrations: [declaration({ id: 'a', event: 'context', before: ['missing'] })],
      }),
    ).toThrow(expect.objectContaining({ code: 'missing_target' }))
    expect(() =>
      normalizeHookSnapshots({
        workspaceId: 'workspace-1',
        configRevision: 1,
        registrations: [
          declaration({ id: 'call', event: 'tool_call', before: ['result'] }),
          declaration({ id: 'result', event: 'tool_result' }),
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'cross_event' }))
    expect(() =>
      normalizeHookSnapshots({
        workspaceId: 'workspace-1',
        configRevision: 1,
        registrations: [
          declaration({ id: 'same', event: 'tool_call', sourceKey: 'one' }),
          declaration({ id: 'same', event: 'tool_result', sourceKey: 'two' }),
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'duplicate_registration' }))
    expect(() =>
      normalizeHookSnapshots({
        workspaceId: 'workspace-1',
        configRevision: 1,
        registrations: [
          declaration({ id: 'one', event: 'tool_call', sourceKey: 'pkg#hook' }),
          declaration({ id: 'two', event: 'tool_result', sourceKey: 'pkg#hook' }),
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'duplicate_source' }))
    expect(() =>
      normalizeHookSnapshots({
        workspaceId: 'workspace-1',
        configRevision: 1,
        registrations: [declaration({ id: 'self', event: 'tool_call', before: ['self'] })],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_registration' }))
    const published = normalizeHookSnapshots({
      workspaceId: 'workspace-1',
      configRevision: 1,
      registrations: [declaration({ id: 'kept', event: 'context' })],
    })
    expect(() =>
      normalizeHookSnapshots({
        workspaceId: 'workspace-1',
        configRevision: 1,
        registrations: [
          declaration({ id: 'a', event: 'context', before: ['b'] }),
          declaration({ id: 'b', event: 'context', before: ['a'] }),
        ],
      }),
    ).toThrow(AssemblyRefusal)
    expect(published[0]?.snapshot.registrations.map((item) => item.registrationId)).toEqual(['kept'])
  })

  it('locks failure policy and gives legacy and interceptor declarations the same snapshot', () => {
    expect(() =>
      normalizeHookSnapshots({
        workspaceId: 'workspace-1',
        configRevision: 1,
        registrations: [
          declaration({ id: 'open', event: 'before_step', failPolicy: 'open', mandatory: false }),
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'policy_widened' }))
    expect(() =>
      normalizeHookSnapshots({
        workspaceId: 'workspace-1',
        configRevision: 1,
        registrations: [declaration({ id: 'watch', event: 'session_start' })],
      }),
    ).toThrow(expect.objectContaining({ code: 'not_interceptor' }))
    const tightened = normalizeHookSnapshots({
      workspaceId: 'workspace-1',
      configRevision: 1,
      registrations: [declaration({ id: 'mask', event: 'tool_result', failPolicy: 'closed' })],
    })
    expect(tightened[0]?.snapshot.registrations[0]?.failPolicy).toBe('closed')
    expect(tightened[0]?.digestMaterial).toMatchObject({ registrations: [{ mandatory: true }] })
    expect(() =>
      normalizeHookSnapshots({
        workspaceId: 'workspace-1',
        configRevision: 1,
        registrations: [declaration({ id: 'mask', event: 'tool_result', mandatory: true })],
      }),
    ).toThrow(expect.objectContaining({ code: 'policy_widened' }))

    const shared = {
      id: 'mask',
      event: 'tool_result' as const,
      provider: PROVIDER,
      codeDigest: DIGEST,
      priority: 2,
      readFields: ['/result'],
      writeFields: ['/content'],
    }
    const legacy = normalizeHookSnapshots({
      workspaceId: 'workspace-1',
      configRevision: 4,
      registrations: [{ ...shared, source: 'legacy', sourceKey: 'legacy:mask' }],
    })
    const modern = normalizeHookSnapshots({
      workspaceId: 'workspace-1',
      configRevision: 4,
      registrations: [{ ...shared, source: 'interceptor', sourceKey: 'pkg#mask', execution: 'opaque' }],
    })
    expect(legacy[0]?.snapshot).toEqual(modern[0]?.snapshot)
    const changed = normalizeHookSnapshots({
      workspaceId: 'workspace-1',
      configRevision: 4,
      registrations: [
        {
          ...shared,
          source: 'interceptor',
          sourceKey: 'pkg#mask',
          execution: 'opaque',
          readFields: ['/meta'],
        },
      ],
    })
    expect(changed[0]?.snapshot.digest).not.toBe(modern[0]?.snapshot.digest)
    expect(changed[0]?.snapshot.registrations).toEqual(modern[0]?.snapshot.registrations)
  })
})
