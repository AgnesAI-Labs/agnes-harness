import type { CandidateContext, JsonValue, ToolDescriptor } from '@agnes/jev-runtime'
import { describe, expect, it } from 'vitest'
import { operationCandidates } from '../src/runtime/jev-operation-candidates.js'

const epoch = 'epoch' as ToolDescriptor['revision'] & Parameters<typeof operationCandidates>[1]
type Facts = CandidateContext['records']
const catalog = (names: string[], id = 'catalog'): Facts =>
  [
    {
      kind: 'resource.observed',
      id,
      resource: { kind: 'jev.skill-catalog.v1', entries: names.map((name) => ({ name })), complete: true },
    },
  ] as unknown as Facts
const receipt = (tool: string, value: JsonValue, args: JsonValue = {}, id = 'call', revision = 'v1'): Facts =>
  [
    {
      kind: 'action.intended',
      id: `${id}-intent`,
      intent: { id, tool, toolRevision: revision, arguments: args },
    },
    {
      kind: 'action.settled',
      id: `${id}-result`,
      intentId: id,
      effect: 'applied',
      outcome: { kind: 'success', value },
    },
  ] as unknown as Facts
function candidates(name: string, records: Facts, limit = 10, revision = 'v1') {
  return [
    ...operationCandidates(
      { name, revision } as ToolDescriptor,
      epoch,
      {
        records,
        limit,
        environmentRecord: {} as never,
      },
      (tool) => tool.revision === 'v1',
    ),
  ]
}
describe('objective skill and child candidates', () => {
  it('offers catalog names only, bounds generation and clears removed catalogs', () => {
    expect(candidates('skill_read', catalog(['a', 'b']), 1).map((c) => c.arguments)).toEqual([{ name: 'a' }])
    expect(candidates('skill_read', [...catalog(['a']), ...catalog([], 'empty')])).toEqual([])
    expect(candidates('skill_read', catalog(['a']), 10, 'replacement')).toEqual([])
  })
  it('continues the latest skill page with its exact version key; full reads become explicit revisits', () => {
    const pageKey = 'a'.repeat(64)
    const facts = [
      ...catalog(['a']),
      ...receipt('skill_read', { name: 'a', pageKey, offset: 0, nextOffset: 20, totalBytes: 40 }),
    ]
    const result = candidates('skill_read', facts)
    expect(result[0]).toMatchObject({
      arguments: { name: 'a', offset: 20, pageKey },
      sourceRecordIds: ['call-result'],
      evidence: [
        { pointer: '/outcome/value/name', value: 'a' },
        { pointer: '/outcome/value/nextOffset', value: 20 },
        { pointer: '/outcome/value/pageKey', value: pageKey },
      ],
    })
    expect(candidates('skill_read', [...facts, ...catalog([], 'removed')])).toEqual([])
    const partial = catalog([], 'partial').map((record) =>
      record.kind === 'resource.observed'
        ? { ...record, resource: { kind: 'jev.skill-catalog.v1', entries: [], complete: false } }
        : record,
    ) as Facts
    expect(candidates('skill_read', [...facts, ...partial])[0]?.arguments).toEqual({
      name: 'a',
      offset: 20,
      pageKey,
    })
    expect(
      candidates('skill_read', [
        ...facts,
        {
          kind: 'candidate.invalidation',
          id: 'failed',
          tool: 'skill_read',
          effectClass: 'read_only',
          effect: 'none',
        } as Facts[number],
      ]).map((c) => c.arguments),
    ).toEqual([{ name: 'a' }])
    const complete = candidates('skill_read', [
      ...facts,
      ...receipt('skill_read', { name: 'a', pageKey, offset: 20, totalBytes: 40 }, {}, 'last'),
    ])
    expect(complete).toHaveLength(1)
    expect(complete[0]).toMatchObject({ arguments: { name: 'a' }, revisit: 'verification' })
    expect(
      candidates(
        'skill_read',
        receipt(
          'skill_read',
          { name: 'a', pageKey, offset: 0, nextOffset: 20, totalBytes: 40 },
          {},
          'bad',
          'foreign',
        ),
      ),
    ).toEqual([])
  })
  it('retains resource revision and relative path from a successful skill file call', () => {
    const args = { resourceId: 'skill/a', expectedRevision: 'b'.repeat(64), relativePath: 'guide.md' }
    const records = receipt(
      'skill_read_file',
      {
        resourceId: args.resourceId,
        relativePath: args.relativePath,
        offset: 0,
        nextOffset: 10,
        totalBytes: 30,
      },
      args,
    )
    const named = receipt(
      'skill_read',
      { name: 'a', resourceId: args.resourceId, pageKey: 'a'.repeat(64), offset: 0, totalBytes: 2 },
      {},
      'named',
    )
    expect(candidates('skill_read_file', [...named, ...records, ...catalog(['b'], 'removed-file')])).toEqual(
      [],
    )
    expect(
      candidates('skill_read_file', [...records, ...catalog(['b'], 'unknown-file')])[0]?.arguments,
    ).toEqual({ ...args, offset: 10 })
    expect(candidates('skill_read_file', records)[0]).toMatchObject({
      arguments: { ...args, offset: 10 },
      sourceRecordIds: ['call-result', 'call-intent'],
    })
    expect(
      candidates(
        'skill_read_file',
        receipt(
          'skill_read_file',
          { resourceId: args.resourceId, relativePath: args.relativePath, artifact: true },
          args,
        ),
      ),
    ).toEqual([])
    expect(
      candidates(
        'skill_read_file',
        receipt(
          'skill_read_file',
          { resourceId: 'other', relativePath: args.relativePath, offset: 0, nextOffset: 10, totalBytes: 30 },
          args,
        ),
      ),
    ).toEqual([])
  })
  it('waits for real child handles and stops after a terminal collection', () => {
    const records = receipt('subagent_spawn', { childKey: 'child' })
    expect(candidates('subagent_collect', records)[0]).toMatchObject({
      arguments: { childKey: 'child', wait: true },
      sourceRecordIds: ['call-result'],
      evidence: [{ pointer: '/outcome/value/childKey', value: 'child' }],
    })
    const running = [
      ...records,
      ...receipt(
        'subagent_collect',
        { childKey: 'child', status: 'running' },
        { childKey: 'child', wait: false },
        'running',
      ),
    ]
    expect(candidates('subagent_collect', running)).toHaveLength(1)
    expect(candidates('subagent_collect', running)[0]).toMatchObject({
      arguments: { childKey: 'child', wait: true },
      sourceRecordIds: ['running-result'],
      evidence: [{ sourceRecordId: 'running-result', pointer: '/outcome/value/childKey', value: 'child' }],
    })
    const repeated = [
      ...running,
      ...receipt(
        'subagent_collect',
        { childKey: 'child', status: 'running' },
        { childKey: 'child', wait: false },
        'running-again',
      ),
    ]
    expect(candidates('subagent_collect', repeated)[0]).toMatchObject({
      arguments: { childKey: 'child', wait: true },
      sourceRecordIds: ['running-again-result'],
    })
    expect(
      candidates('subagent_collect', [
        ...running,
        {
          kind: 'candidate.invalidation',
          id: 'failed-collect',
          tool: 'subagent_collect',
          effectClass: 'external_write',
          effect: 'unknown',
        } as Facts[number],
      ]),
    ).toEqual([])
    for (const status of ['completed', 'failed', 'cancelled'])
      expect(
        candidates('subagent_collect', [
          ...running,
          ...receipt('subagent_collect', { childKey: 'child', status }, {}, 'done'),
        ]),
      ).toEqual([])
    expect(
      candidates('subagent_collect', [
        ...running,
        ...receipt('subagent_collect', { childKey: 'child', status: 'completed' }, {}, 'terminal'),
        ...receipt('subagent_send_message', { childKey: 'child' }, {}, 'resume'),
      ])[0]?.arguments,
    ).toEqual({ childKey: 'child', wait: true })
    const cancelled = [
      ...running,
      ...receipt(
        'subagent_cancel',
        { childKey: 'child', status: 'cancelled' },
        { childKey: 'child' },
        'cancel',
      ),
    ]
    expect(candidates('subagent_collect', cancelled)[0]).toMatchObject({
      arguments: { childKey: 'child', wait: true },
      sourceRecordIds: ['cancel-result'],
    })
    expect(
      candidates('subagent_collect', [
        ...cancelled,
        ...receipt(
          'subagent_collect',
          { childKey: 'child', status: 'cancelled' },
          { childKey: 'child', wait: true },
          'confirmed',
        ),
      ]),
    ).toEqual([])
    const siblings = [
      ...running,
      ...receipt('subagent_spawn', { childKey: 'sibling' }, {}, 'sibling'),
      ...receipt(
        'subagent_collect',
        { childKey: 'child', status: 'completed' },
        { childKey: 'child', wait: true },
        'terminal-child',
      ),
    ]
    expect(candidates('subagent_collect', siblings).map((candidate) => candidate.arguments)).toEqual([
      { childKey: 'sibling', wait: true },
    ])
    for (const effect of ['unknown', 'not_applied'] as const) {
      const refused = records.map((record) =>
        record.kind === 'action.settled' ? { ...record, effect } : record,
      )
      expect(candidates('subagent_collect', refused)).toEqual([])
    }
    expect(
      candidates(
        'subagent_collect',
        receipt('subagent_spawn', { childKey: 'foreign' }, {}, 'foreign', 'replacement'),
      ),
    ).toEqual([])
    expect(candidates('subagent_collect', receipt('subagent_send_message', { childKey: 'parent' }))).toEqual(
      [],
    )
    expect(candidates('subagent_collect', receipt('shell', { childKey: 'forged' }))).toEqual([])
  })
})
