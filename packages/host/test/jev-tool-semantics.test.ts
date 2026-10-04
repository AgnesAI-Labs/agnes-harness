import { readFileSync } from 'node:fs'
import { askUserQuestionTool, subagentInterruptTool, subagentSendMessageTool } from '@agnes/base'
import { type SessionImpl, ToolRegistry } from '@agnes/core'
import { readTool } from '@agnes/core/testkit'
import type { ToolContext, ToolDef } from '@agnes/extension-api'
import type {
  CandidateContext,
  FrozenIntent,
  JsonValue,
  LedgerEntry,
  RuntimeLedger,
  RuntimeRecord,
  ToolDescriptor,
} from '@agnes/jev-runtime'
import { type TSchema, Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { createJevToolSemantics } from '../src/runtime/jev-tool-semantics.js'

const epoch = 'epoch' as FrozenIntent['environmentEpoch']
type FixtureSchema = {
  type: string
  properties?: Record<string, FixtureSchema>
  required?: string[]
  items?: FixtureSchema
  [key: string]: unknown
}
function fixtureSchema(value: FixtureSchema): TSchema {
  const { type, properties, required, items, ...constraints } = value
  if (type === 'object')
    return Type.Object(
      Object.fromEntries(
        Object.entries(properties ?? {}).map(([key, field]) => {
          const converted = fixtureSchema(field)
          return [key, required?.includes(key) ? converted : Type.Optional(converted)]
        }),
      ),
      constraints,
    )
  if (type === 'array' && items) return Type.Array(fixtureSchema(items), constraints)
  if (type === 'string') return Type.String(constraints)
  if (type === 'boolean') return Type.Boolean(constraints)
  if (type === 'integer') return Type.Integer(constraints)
  throw new Error(`Unsupported fixture type ${type}`)
}
function fixture(sourceOverride?: string, trust: 'builtin' | 'trusted' = 'builtin', changedSchema = false) {
  const registry = new ToolRegistry()
  const baseTool = readTool() as ToolDef
  for (const name of ['read', 'find', 'grep', 'ls', 'write', 'edit']) {
    const properties = JSON.parse(
      readFileSync(new URL(`../../base/fixtures/tool-schemas/${name}.json`, import.meta.url), 'utf8'),
    )
    if (changedSchema) properties.properties.path.minLength = 2
    registry.add(
      {
        ...baseTool,
        meta: { ...baseTool.meta, isReadOnly: name !== 'write' && name !== 'edit' },
        name,
        parameters: fixtureSchema(properties),
      },
      {
        source:
          sourceOverride ??
          (['read', 'write', 'edit'].includes(name) ? 'agnes/tools-core' : 'agnes/tools-search'),
        trust,
      },
    )
  }
  let bytes = new TextEncoder().encode('one\ntwo\nthree\nfour\n')
  const fs = {
    read: async () => bytes,
    write: async () => {},
    list: async () => [],
    stat: async () => ({ kind: 'file', size: bytes.length, mtimeMs: 1 }),
  }
  const session = {
    lastSeq: 1,
    ac: new AbortController(),
    currentTools: () => registry,
    d: {
      cwd: '/w',
      workspaceInvocation: {
        run: async (handler: (view: unknown) => Promise<unknown>) =>
          handler({ ready: async () => ({}), fs: () => fs }),
      },
    },
  } as unknown as SessionImpl
  const entries: LedgerEntry<number>[] = []
  const ledger: RuntimeLedger<number> = {
    read: async () => entries,
    cursorText: String,
    commit: async (record) => {
      entries.push({ cursor: entries.length + 1, record })
      return entries.length
    },
  }
  const companions = createJevToolSemantics({ session, ledger, readPageLines: 2 })
  const descriptor = (name: string): ToolDescriptor => {
    const def = registry.snapshot(1).byName.get(name)
    if (!def) throw new Error('Missing fixture')
    return {
      name,
      description: name,
      parameters: JSON.parse(JSON.stringify(def.parameters)) as JsonValue,
      output: {},
      revision: def.definitionFingerprint,
      effectClass: def.meta.isReadOnly ? 'read_only' : 'workspace_mutation',
    }
  }
  const context = { cwd: '/w', fs } as unknown as ToolContext
  const intent = (name: string, args: Record<string, JsonValue> = {}): FrozenIntent => ({
    id: 'intent' as FrozenIntent['id'],
    tool: name,
    toolRevision: descriptor(name).revision,
    arguments: args,
    environmentEpoch: epoch,
    effectClass: descriptor(name).effectClass as FrozenIntent['effectClass'],
  })
  const records = (name: string, value: JsonValue, meta?: JsonValue): CandidateContext['records'] =>
    [
      { kind: 'action.intended', id: 'i1', intent: intent(name), version: 1, turn: 't', decision: 'd' },
      {
        kind: 'action.settled',
        id: 's1',
        intentId: 'intent',
        version: 1,
        turn: 't',
        effect: 'none',
        observations: [],
        outcome: { kind: 'success', value, ...(meta ? { meta } : {}) },
      },
    ] as unknown as CandidateContext['records']
  const candidates = (name: string, facts: CandidateContext['records'], limit = 10) => [
    ...companions.semantics.candidates(descriptor(name), [], epoch, {
      records: facts,
      limit,
      environmentRecord: {} as never,
    }),
  ]
  return {
    ...companions,
    registry,
    descriptor,
    intent,
    context,
    ledger,
    records,
    candidates,
    replaceBytes: (value: string) => {
      bytes = new TextEncoder().encode(value)
    },
  }
}

const readFact = {
  codec: 'agnes-host-tool-fact-v1',
  tool: 'read',
  target: { kind: 'file', path: '/w/a' },
  page: { firstLine: 1, lastLine: 2, nextOffset: 3, totalLines: 4 },
  coverage: { complete: false, sourceTruncated: false, continuationSafe: true, lineContentTruncated: false },
} satisfies JsonValue

describe('verified Agnes tool companions', () => {
  it('binds purpose profiles and mutation verification candidates to verified registrations and successful facts', () => {
    const h = fixture()
    for (const name of ['read', 'find', 'grep', 'ls']) {
      expect(h.describeTool(h.descriptor(name))).toMatchObject({
        operation: name,
        toolRevision: h.descriptor(name).revision,
        phases: ['INSPECT', 'VERIFY'],
      })
    }
    for (const name of ['write', 'edit']) {
      expect(h.describeTool(h.descriptor(name))?.phases).toEqual(['ACT'])
      const fact = {
        codec: 'agnes-host-tool-fact-v1',
        tool: name,
        target: { kind: 'file', path: '/w/nested/result.txt' },
        write: {
          acknowledged: true,
          versionSource: 'submitted-utf8-bytes-sha256',
          size: 3,
          digest: 'a'.repeat(64),
        },
      }
      const records = h.records(name, fact)
      expect(h.candidates('read', records)).toMatchObject([
        {
          arguments: { path: '/w/nested/result.txt', offset: 1, limit: 2 },
          sourceRecordIds: ['s1'],
          evidence: expect.arrayContaining([
            { sourceRecordId: 's1', pointer: '/outcome/value/target/path', value: '/w/nested/result.txt' },
          ]),
        },
      ])
      const settlement = records[1]
      const intended = records[0]
      if (!intended || settlement?.kind !== 'action.settled') throw new Error('Missing settlement')
      expect(h.candidates('read', [intended, { ...settlement, effect: 'unknown' }])).toEqual([])
      expect(
        h.candidates('read', [intended, { ...settlement, outcome: { kind: 'error', value: fact } }]),
      ).toEqual([])
      expect(
        h.candidates('read', h.records(name, { ...fact, write: { ...fact.write, acknowledged: false } })),
      ).toEqual([])
      expect(h.describeTool({ ...h.descriptor(name), revision: 'replacement' })).toBeUndefined()
      if (intended.kind !== 'action.intended') throw new Error('Missing intended action')
      expect(
        h.candidates('read', [
          { ...intended, intent: { ...intended.intent, toolRevision: 'replacement' } },
          settlement,
        ]),
      ).toEqual([])
    }
    for (const unverified of [
      fixture('third-party/tools'),
      fixture(undefined, 'trusted'),
      fixture(undefined, 'builtin', true),
    ]) {
      for (const name of ['read', 'write', 'edit']) {
        expect(unverified.describeTool(unverified.descriptor(name))).toBeUndefined()
      }
    }
  })
  it('maps bounded find/grep/ls facts into revision-bound complete read arguments and evidence', () => {
    const h = fixture()
    const found = h.records('find', {
      codec: 'agnes-host-tool-fact-v1',
      tool: 'find',
      paths: ['/w/a', '/w/b'],
      coverage: { complete: false },
    })
    const [candidate] = h.candidates('read', found, 1)
    expect(candidate).toMatchObject({
      arguments: { path: '/w/a' },
      environmentEpoch: epoch,
      toolRevision: h.descriptor('read').revision,
      sourceRecordIds: ['s1'],
      evidence: [{ pointer: '/outcome/value/paths/0', value: '/w/a' }],
    })
    expect(candidate?.arguments).toEqual({ path: '/w/a' })
    expect(h.candidates('read', found, 1)).toHaveLength(1)
    expect(
      h.candidates(
        'read',
        h.records('grep', {
          codec: 'agnes-host-tool-fact-v1',
          tool: 'grep',
          matches: [{ path: '/w/a', lineNumber: 8 }],
        }),
      ),
    ).toMatchObject([{ arguments: { path: '/w/a' } }])
    const listing = h.records('ls', {
      codec: 'agnes-host-tool-fact-v1',
      tool: 'ls',
      entries: [
        { path: '/w/src', kind: 'dir' },
        { path: '/w/a', kind: 'file' },
      ],
    })
    expect(h.candidates('ls', listing)).toMatchObject([{ arguments: { path: '/w/src' } }])
    expect(h.candidates('read', listing).map((candidate) => candidate.arguments)).toEqual([{ path: '/w/a' }])
    const workspace = [
      {
        kind: 'resource.observed',
        id: 'root1',
        version: 1,
        turn: 't',
        resource: {
          kind: 'jev.workspace-directory.v1',
          root: '/w',
          status: 'observed',
          environmentEpoch: epoch,
          entries: [
            { path: 'a', kind: 'file' },
            { path: 'src', kind: 'directory' },
            { path: '../escape', kind: 'file' },
          ],
          complete: false,
          omitted: 10,
        },
      },
    ] as unknown as CandidateContext['records']
    expect(h.candidates('read', workspace).map((candidate) => candidate.arguments)).toEqual([
      { path: '/w/a' },
    ])
    expect(h.candidates('read', workspace)).toMatchObject([
      {
        arguments: { path: '/w/a' },
        sourceRecordIds: ['root1'],
        evidence: [
          { pointer: '/resource/root', value: '/w' },
          { pointer: '/resource/entries/0/path', value: 'a' },
          { pointer: '/resource/entries/0/kind', value: 'file' },
        ],
      },
    ])
    expect(h.candidates('ls', workspace)).toMatchObject([
      {
        arguments: { path: '/w' },
        environmentEpoch: epoch,
        toolRevision: h.descriptor('ls').revision,
        sourceRecordIds: ['root1'],
        evidence: [
          { pointer: '/resource/root', value: '/w' },
          { pointer: '/resource/status', value: 'observed' },
        ],
      },
      { arguments: { path: '/w/src' } },
    ])
    expect(h.candidates('ls', workspace, 1)).toMatchObject([{ arguments: { path: '/w' } }])
    expect(h.candidates('ls', workspace, 0)).toEqual([])
    for (const companion of [
      fixture('third-party/tools'),
      fixture(undefined, 'trusted'),
      fixture(undefined, 'builtin', true),
    ])
      expect(companion.candidates('ls', workspace)).toEqual([])
    for (const complete of [false, true]) {
      expect(
        h.candidates('ls', [
          {
            ...workspace[0],
            resource: {
              kind: 'jev.workspace-directory.v1',
              root: '/w',
              status: 'observed',
              entries: [],
              complete,
            },
          },
        ] as unknown as CandidateContext['records']),
      ).toMatchObject([{ arguments: { path: '/w' } }])
    }
    expect(
      h.candidates('read', [
        ...workspace,
        {
          ...workspace[0],
          id: 'root2',
          resource: { kind: 'jev.workspace-directory.v1', root: '/w', status: 'unavailable', entries: [] },
        },
      ] as unknown as CandidateContext['records']),
    ).toEqual([])
    for (const resource of [
      { kind: 'jev.workspace-directory.v1', root: '/w', status: 'unavailable', entries: [] },
      { kind: 'jev.workspace-directory.v1', root: '/other', status: 'observed', entries: [] },
    ]) {
      expect(
        h.candidates('ls', [
          ...workspace,
          { ...workspace[0], id: 'root2', resource },
        ] as unknown as CandidateContext['records']),
      ).toEqual([])
    }
    expect(
      h.candidates('ls', [
        ...workspace,
        { kind: 'candidate.invalidation' },
      ] as unknown as CandidateContext['records']),
    ).toEqual([])
    expect(
      h.candidates('read', [
        ...workspace,
        { kind: 'candidate.invalidation' },
      ] as unknown as CandidateContext['records']),
    ).toEqual([])
  })

  it('captures actual read bytes and rejects stale, misbound and truncated continuation evidence', async () => {
    const h = fixture()
    const observed = await h.observeExecution(
      h.intent('read', { path: '/w/a' }),
      h.context,
      async (context) => {
        await context.fs.read('/w/a', { limit: 4 * 1024 * 1024 + 1 })
        return { content: [{ type: 'text', text: 'page' }], structured: readFact }
      },
    )
    const records = h.records('read', readFact, observed.meta)
    const [candidate] = h.candidates('read', records)
    expect(candidate).toMatchObject({
      arguments: { path: '/w/a', offset: 3, limit: 2 },
      preconditions: { codec: 'agnes-read-continuation-v1', path: '/w/a', size: 19 },
    })
    if (!candidate?.preconditions) throw new Error('Missing continuation')
    for (const record of records) await h.ledger.commit(record as RuntimeRecord)
    expect(
      await h.validatePreconditions(candidate.preconditions, h.descriptor('read'), candidate.arguments),
    ).toBe(true)
    expect(
      await h.validatePreconditions(candidate.preconditions, h.descriptor('read'), {
        ...candidate.arguments,
        path: '/w/b',
      }),
    ).toBe(false)
    expect(
      h.candidates(
        'read',
        h.records(
          'read',
          { ...readFact, coverage: { ...readFact.coverage, sourceTruncated: true } },
          observed.meta,
        ),
      ),
    ).toEqual([])
    expect(h.candidates('read', h.records('read', readFact))).toEqual([])
    h.replaceBytes('changed content')
    expect(
      await h.validatePreconditions(candidate.preconditions, h.descriptor('read'), candidate.arguments),
    ).toBe(false)
    await expect(
      h.observeExecution(
        { ...h.intent('read', candidate.arguments), preconditions: candidate.preconditions },
        h.context,
        async (context) => {
          await context.fs.read('/w/a', { limit: 4 * 1024 * 1024 + 1 })
          return { content: [] }
        },
      ),
    ).rejects.toThrow('source changed')
  })

  it('does not adopt same-named foreign tools or facts predating a mutation', () => {
    const foreign = fixture('third-party/tools')
    expect(
      foreign.candidates(
        'read',
        foreign.records('find', { codec: 'agnes-host-tool-fact-v1', tool: 'find', paths: ['/w/a'] }),
      ),
    ).toEqual([])
    const h = fixture()
    const records = [
      ...h.records('find', { codec: 'agnes-host-tool-fact-v1', tool: 'find', paths: ['/w/a'] }),
      {
        kind: 'candidate.invalidation',
        id: 'mutation',
        tool: 'write',
        effectClass: 'workspace_mutation',
        effect: 'acknowledged',
      },
    ] as unknown as CandidateContext['records']
    expect(h.candidates('read', records)).toEqual([])
    expect([
      ...h.semantics.candidates({ ...h.descriptor('read'), revision: 'replacement' }, [], epoch, {
        records: h.records('find', { codec: 'agnes-host-tool-fact-v1', tool: 'find', paths: ['/w/a'] }),
        limit: 10,
        environmentRecord: {} as never,
      }),
    ]).toEqual([])
  })
})

describe('verified human-question companion', () => {
  function questionFixture(change: 'none' | 'source' | 'trust' | 'schema' | 'meta' | 'description' = 'none') {
    const registry = new ToolRegistry()
    registry.add(
      {
        ...askUserQuestionTool,
        ...(change === 'schema' ? { parameters: Type.Object({ questions: Type.Array(Type.String()) }) } : {}),
        ...(change === 'meta' ? { meta: { ...askUserQuestionTool.meta, replay: 'safe' as const } } : {}),
        ...(change === 'description' ? { description: 'An unverified replacement' } : {}),
      } as ToolDef,
      {
        source: change === 'source' ? 'other/tools-core' : 'agnes/tools-core',
        trust: change === 'trust' ? 'trusted' : 'builtin',
      },
    )
    const session = { lastSeq: 1, currentTools: () => registry } as unknown as SessionImpl
    const ledger = fixture().ledger
    const companions = createJevToolSemantics({ session, ledger })
    const definition = registry.snapshot(1).byName.get('ask_user_question')
    if (!definition) throw new Error('Missing question tool')
    const tool: ToolDescriptor = {
      name: definition.name,
      description: definition.description,
      revision: definition.definitionFingerprint,
      parameters: JSON.parse(JSON.stringify(definition.parameters)),
      output: {},
    }
    return { companions, tool }
  }

  it('exposes the exact builtin in every phase as an external interaction without objective candidates', () => {
    const { companions, tool } = questionFixture()
    expect(companions.describeTool(tool)).toMatchObject({
      operation: tool.name,
      toolRevision: tool.revision,
      phases: ['INSPECT', 'ACT', 'VERIFY'],
    })
    expect(companions.effectClass(tool)).toBe('external_write')
    expect(companions.isQuestionTool(tool)).toBe(true)
    expect([...companions.semantics.candidates(tool, [], epoch)]).toEqual([])
    expect(companions.describeTool({ ...tool, revision: 'stale' })).toBeUndefined()
    expect(companions.effectClass({ ...tool, revision: 'stale' })).toBeUndefined()
    expect(companions.isQuestionTool({ ...tool, revision: 'stale' })).toBe(false)
  })

  it.each(['source', 'trust', 'schema', 'meta', 'description'] as const)(
    'does not confer trusted question semantics on a changed %s',
    (change) => {
      const { companions, tool } = questionFixture(change)
      expect(companions.describeTool(tool)).toBeUndefined()
      expect(companions.effectClass(tool)).toBeUndefined()
      expect(companions.isQuestionTool(tool)).toBe(false)
    },
  )
})

describe('verified continuable-child companions', () => {
  it.each([subagentSendMessageTool, subagentInterruptTool])(
    'pins the full $name contract and its first revision',
    (builtin) => {
      for (const change of ['none', 'source', 'trust', 'schema', 'meta', 'description'] as const) {
        const registry = new ToolRegistry()
        registry.add(
          {
            ...builtin,
            ...(change === 'schema' ? { parameters: Type.Object({ childKey: Type.String() }) } : {}),
            ...(change === 'meta' ? { meta: { ...builtin.meta, replay: 'safe' as const } } : {}),
            ...(change === 'description' ? { description: 'replacement' } : {}),
          } as ToolDef,
          {
            source: change === 'source' ? 'third-party/subagent' : 'agnes/subagent',
            trust: change === 'trust' ? 'trusted' : 'builtin',
          },
        )
        const session = { lastSeq: 1, currentTools: () => registry } as unknown as SessionImpl
        const companions = createJevToolSemantics({ session, ledger: fixture().ledger })
        const definition = registry.snapshot(1).byName.get(builtin.name)
        if (!definition) throw new Error('Missing builtin')
        const tool: ToolDescriptor = {
          name: definition.name,
          revision: definition.definitionFingerprint,
          description: definition.description,
          parameters: JSON.parse(JSON.stringify(definition.parameters)),
          output: {},
        }
        if (change === 'none') {
          expect(companions.describeTool(tool)).toMatchObject({ phases: ['ACT'] })
          expect(companions.effectClass(tool)).toBe('external_write')
          expect(companions.describeTool({ ...tool, revision: 'replacement' })).toBeUndefined()
          expect(companions.effectClass({ ...tool, revision: 'replacement' })).toBeUndefined()
        } else {
          expect(companions.describeTool(tool)).toBeUndefined()
          expect(companions.effectClass(tool)).toBeUndefined()
        }
        expect(companions.isQuestionTool(tool)).toBe(false)
        expect([...companions.semantics.candidates(tool, [], epoch)]).toEqual([])
      }
    },
  )
})
