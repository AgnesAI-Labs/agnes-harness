import type { ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { artifactUri, toLedgerContent } from '../src/effects/tool-result.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

const ref = { sha256: 'a'.repeat(64), size: 3, mime: 'image/png' }

describe('toLedgerContent', () => {
  it('maps author blocks to protocol ContentBlock', () => {
    expect(
      toLedgerContent([
        { type: 'text', text: 'hi' },
        { type: 'image', ref, mime: 'image/png' },
        { type: 'ref', ref: { ...ref, mime: 'text/csv' } },
      ]),
    ).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'resource_link', uri: `artifact://${'a'.repeat(64)}`, mimeType: 'image/png', name: 'image' },
      { type: 'resource_link', uri: `artifact://${'a'.repeat(64)}`, mimeType: 'text/csv', name: 'artifact' },
    ])
    expect(artifactUri(ref)).toBe(`artifact://${'a'.repeat(64)}`)
  })

  // ArtifactRef carries `mime` as a required key, so a `ref` block with no block-level mime still
  // gets one from the ref. Walked here because it is the shape base's tools actually produce: an
  // artifact handed back without restating its type.
  it('a ref block with no block-level mime takes the mime off the ref', () => {
    expect(toLedgerContent([{ type: 'ref', ref }])).toEqual([
      { type: 'resource_link', uri: `artifact://${'a'.repeat(64)}`, mimeType: 'image/png', name: 'artifact' },
    ])
  })

  // The block-level mime is what the author said this use of the artifact is, so it wins over the
  // type the artifact was stored under. Walked because the two disagree only here, and a converter
  // that read the ref first would look right in every other case.
  it('a block-level mime overrides the one on the ref', () => {
    expect(toLedgerContent([{ type: 'ref', ref, mime: 'text/csv' }])).toEqual([
      { type: 'resource_link', uri: `artifact://${'a'.repeat(64)}`, mimeType: 'text/csv', name: 'artifact' },
    ])
  })
})

describe('the tools phase records converted blocks', () => {
  // The conversion is only worth anything where it is wired in. A tool handing back an artifact is
  // the case the author shape exists for, and the row it lands on is what the next request shows the
  // model - so the assertion is on the ledger, not on the converter called a second time.
  it('an artifact a tool returns reaches the ledger as a resource_link', async () => {
    const registry = new ToolRegistry()
    registry.add(
      {
        name: 'read',
        description: 'read',
        parameters: Type.Object({}),
        meta: {
          isReadOnly: true,
          isDestructive: false,
          isConcurrencySafe: true,
          isOpenWorld: false,
          replay: 'safe',
          costHint: undefined,
          deferLoading: undefined,
          requiresApproval: undefined,
        },
        execute: async () => ({ content: [{ type: 'ref', ref, mime: 'text/csv' }] }),
      } as never,
      { source: 's', trust: 'builtin' },
    )
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('read', { x: 1 }), textTurn('done')]),
      registry,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const rows = await log.scan({ type: 'tool/result', limit: 5 })
    expect((rows[0]?.data as { content?: unknown })?.content).toEqual([
      { type: 'resource_link', uri: `artifact://${'a'.repeat(64)}`, mimeType: 'text/csv', name: 'artifact' },
    ])
  })

  it('records only the public structured result and never UI-only details', async () => {
    const registry = new ToolRegistry()
    const def = readTool() as ToolDef
    def.execute = async () => ({
      content: [{ type: 'text', text: 'human result' }],
      structured: { rows: 2, source: 'public' },
      details: { selectedTab: 'private-ui' },
    })
    registry.add(def, { source: 's', trust: 'builtin' })
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('read', {}), textTurn('done')]),
      registry,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const data = (await log.scan({ type: 'tool/result', limit: 5 }))[0]?.data
    expect(data).toMatchObject({ structured: { rows: 2, source: 'public' } })
    expect(JSON.stringify(data)).not.toContain('private-ui')
  })
})

describe('the toolResult hook can override what the tools phase records and returns', () => {
  it('passes the real enforcement shape and applies the override to the ledger row', async () => {
    const registry = new ToolRegistry()
    registry.add(readTool(), { source: 's', trust: 'builtin' })
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('read', { path: 'a' }), textTurn('done')]),
      registry,
    })
    let seenEnforcement: unknown
    let seenArgs: unknown
    session.hooks = {
      ...session.hooks,
      toolResult: async (p) => {
        seenEnforcement = p.enforcement
        seenArgs = p.args
        return { result: { content: [{ type: 'text', text: 'overridden' }] } }
      },
    }
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    // The real shape `s.d.runtime.enforcement()` returns — {level, scope} — not the placeholder the
    // design's sample code left in `{ level: enforcement(), scope: [] }`.
    expect(seenEnforcement).toEqual({ level: 'full', scope: ['file', 'network', 'process'] })
    expect(seenArgs).toEqual({ path: 'a' })
    const rows = await log.scan({ type: 'tool/result', limit: 5 })
    expect((rows[0]?.data as { content?: unknown })?.content).toEqual([{ type: 'text', text: 'overridden' }])
  })
})
