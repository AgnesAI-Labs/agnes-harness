import type { CallContext } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  contextFixtureData,
  contextInline,
} from '../../../extension-api/testkit/runtime/contracts/context.js'
import { createTestServiceContainer } from '../../../extension-api/testkit/runtime/harness.js'
import { type ContextSourceSnapshot, createContextFactory } from '../../src/runtime/providers/context.js'

type Creator = typeof createContextFactory
async function creator(id: 'default' | 'reference'): Promise<Creator> {
  if (id === 'default') return createContextFactory
  const reference = (await import(
    new URL('../../../../examples/runtime-reference/src/providers/context.ts', import.meta.url).href
  )) as { createReferenceContextFactory: Creator }
  return reference.createReferenceContextFactory
}
async function open(id: 'default' | 'reference') {
  const data = contextFixtureData(id === 'default' ? 'agh.default/context' : 'reference/context')
  const source: ContextSourceSnapshot = structuredClone(data.source)
  const state = {
    allowed: true,
    available: true,
    capture: () => {},
    check: () => {},
    sourceCheck: (_source: ContextSourceSnapshot) => {},
  }
  const factory = (await creator(id))({
    ...data,
    deployment: {
      capture: () => {
        state.capture()
        return { ok: true, value: source }
      },
      checkCurrent: () => {
        state.check()
        return state.allowed
      },
      sourceCurrent: (captured) => {
        state.sourceCheck(captured)
        return state.available
      },
    },
  })
  const provider = await factory.create(
    data.config,
    createTestServiceContainer().dependencies,
    data.factoryContext,
  )
  expect(await provider.ready(data.context)).toEqual({ ok: true, value: undefined })
  const query = (request = data.request, call: CallContext = data.context) => {
    if (!provider.query) throw new Error('query absent')
    return provider.query(request, call)
  }
  function input(change: (value: W.ContextViewRequest) => void) {
    if (data.request.input.kind !== 'inline') throw new Error('inline fixture expected')
    const parsed = validateRuntime('ContextViewRequest', structuredClone(data.request.input.value))
    if (!parsed.ok) throw new Error('fixture invalid')
    change(parsed.value)
    const { digest: _digest, ...contributions } = parsed.value.contributions
    parsed.value.contributions.digest = canonicalJsonDigest(contributions)
    data.request.input = contextInline(RuntimeMethodSchemaRefs['agh.context'].view.input, parsed.value)
    if (data.request.input.kind === 'inline') source.inputDigest = data.request.input.digest
  }
  return { ...data, source, state, factory, provider, query, input }
}

describe.each(['default', 'reference'] as const)('%s fixed Context view slice', (id) => {
  it('returns the original text and provenance without changing its source, with complete output proofs', async () => {
    const f = await open(id)
    const original = structuredClone(f.source)
    try {
      const result = await f.query()
      expect(result.ok).toBe(true)
      if (!result.ok || result.value.kind !== 'value' || result.value.output.kind !== 'inline')
        throw new Error('view expected')
      const view = validateRuntime('ContextView', result.value.output.value)
      if (!view.ok) throw new Error('view schema')
      const { digest, ...content } = view.value
      expect(digest).toBe(canonicalJsonDigest(content))
      expect(result.value.output.digest).toBe(canonicalJsonDigest(result.value.output.value))
      expect(result.value.output.schema).toEqual(RuntimeMethodSchemaRefs['agh.context'].view.output)
      expect(view.value.items[0]?.body).toEqual(original.items[0]?.body)
      expect(view.value.items[0]?.trust).toBe('user')
      expect(view.value.items[0]?.sourceRefs).toEqual(original.items[0]?.sourceRefs)
      const originalBody = original.items[0]?.body
      expect(view.value.tokenEstimate).toBeGreaterThanOrEqual(
        originalBody?.kind === 'inline' ? originalBody.bytes : 0,
      )
      expect(view.value.runtimeInstructionRefs).toEqual([])
      expect(f.source).toEqual(original)
      expect(result.value.snapshot).toBe('fixture-snapshot')
    } finally {
      await f.provider.close('shutdown')
    }
  })

  it.each([
    'scope',
    'binding',
    'authority',
    'revision',
    'snapshot',
    'digest',
    'bytes',
    'body',
    'provenance',
    'foreign-source',
    'trust',
    'range',
    'protection',
    'duplicate',
    'pair',
    'hooks',
    'hook-digest',
    'token-limit',
    'format',
    'resource',
    'contribution',
    'source',
    'revoke',
  ] as const)('refuses %s without a successful view', async (bad) => {
    const f = await open(id)
    let call = f.context
    const item = f.source.items[0]
    if (!item) throw new Error('fixture item absent')
    try {
      if (bad === 'scope') call = { ...call, scope: { ...call.scope, runId: 'foreign' } as W.ScopeRef }
      if (bad === 'binding') f.request.target.providerId = 'foreign'
      if (bad === 'authority')
        f.input((input) => {
          input.sessionRef.authority.authorityId = 'foreign'
        })
      if (bad === 'revision')
        f.input((input) => {
          input.atRevision++
        })
      if (bad === 'snapshot') f.request.snapshot = 'foreign'
      if (bad === 'digest' && f.request.input.kind === 'inline') f.request.input.digest = 'a'.repeat(64)
      if (bad === 'bytes' && f.request.input.kind === 'inline') f.request.input.bytes++
      if (bad === 'body' && item.body.kind === 'inline') item.body.digest = 'a'.repeat(64)
      if (bad === 'provenance') item.sourceRefs = []
      if (bad === 'foreign-source')
        item.sourceRefs = [{ kind: 'session', value: { ...f.source.session, sessionId: 'foreign' } }]
      if (bad === 'trust') item.trust = 'invalid' as W.ContextItem['trust']
      if (bad === 'range')
        item.sourceRanges = [{ session: f.source.session, fromSeq: 2, toSeq: 1, digest: 'a'.repeat(64) }]
      if (bad === 'protection') f.source.protectedRefs = []
      if (bad === 'duplicate') f.source.items = [item, item]
      if (bad === 'pair') {
        item.kind = 'tool-call'
        item.toolPairRef = 'pending-pair'
      }
      if (bad === 'hooks') {
        f.source.hooks.registrations = [
          {
            registrationId: 'hook',
            provider: f.request.target,
            codeDigest: 'a'.repeat(64),
            ordinal: 0,
            mode: 'waterfall',
            category: 'transform',
            failPolicy: 'closed',
            replayOnResume: false,
            timeoutMs: 100,
          },
        ]
        const { digest: _digest, ...hooks } = f.source.hooks
        f.source.hooks.digest = canonicalJsonDigest(hooks)
      }
      if (bad === 'hook-digest') f.source.hooks.digest = 'a'.repeat(64)
      if (bad === 'token-limit')
        f.input((input) => {
          input.target.tokenLimit = 0
        })
      if (bad === 'format')
        f.input((input) => {
          input.target.format = 'unsupported'
        })
      if (bad === 'resource')
        f.input((input) => {
          input.resourceRefs = [{ kind: 'session', value: f.source.session }]
        })
      if (bad === 'contribution')
        f.input((input) => {
          input.contributions.runtimeContext = [{ source: f.request.target, content: item.body }]
        })
      if (bad === 'source') f.state.available = false
      if (bad === 'revoke') f.state.allowed = false
      const result = await f.query(f.request, call)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('refusal expected')
      if (bad === 'token-limit')
        expect(result.error).toMatchObject({ code: 'quota', detailCode: 'context_token_limit' })
      if (bad === 'hooks') expect(result.error.detailCode).toBe('context_hook_preparation_unavailable')
      if (bad === 'foreign-source') expect(result.error.detailCode).toBe('context_item_source_unavailable')
      if (bad === 'authority' || bad === 'revision' || bad === 'snapshot')
        expect(result.error).toMatchObject({ code: 'conflict', detailCode: 'context_stale_snapshot' })
      if (bad === 'source' || bad === 'revoke') expect(result.error.code).toBe('denied')
    } finally {
      await f.provider.close('shutdown')
    }
  })

  it('preserves external trust and complete protected tool pairs', async () => {
    const f = await open(id)
    const item = f.source.items[0]
    if (!item) throw new Error('item missing')
    try {
      const call: W.ContextItem = {
        ...structuredClone(item),
        id: 'call',
        kind: 'tool-call',
        toolPairRef: 'pair',
      }
      const result: W.ContextItem = {
        ...structuredClone(item),
        id: 'result',
        kind: 'tool-result',
        toolPairRef: 'pair',
        trust: 'external',
      }
      f.source.items = [item, call, result]
      const reply = await f.query()
      if (!reply.ok || reply.value.kind !== 'value' || reply.value.output.kind !== 'inline')
        throw new Error('view expected')
      const parsed = validateRuntime('ContextView', reply.value.output.value)
      if (!parsed.ok) throw new Error('view expected')
      expect(parsed.value.items.map((value) => [value.id, value.trust])).toEqual([
        ['message', 'user'],
        ['call', 'user'],
        ['result', 'external'],
      ])
      expect(parsed.value.protectedRefs).toEqual(f.source.protectedRefs)
    } finally {
      await f.provider.close('shutdown')
    }
  })

  it('cancels before and during source capture and rejects CPU work crossing the deadline', async () => {
    const f = await open(id)
    const controller = new AbortController()
    try {
      controller.abort()
      expect(await f.query(f.request, { ...f.context, signal: controller.signal })).toMatchObject({
        ok: false,
        error: { code: 'cancelled' },
      })
      const during = new AbortController()
      f.state.capture = () => {
        during.abort()
        throw new Error('source private details')
      }
      expect(await f.query(f.request, { ...f.context, signal: during.signal })).toMatchObject({
        ok: false,
        error: { code: 'cancelled' },
      })
      expect(await f.query()).toMatchObject({
        ok: false,
        error: { code: 'internal', detailCode: 'context_source_failed' },
      })
      const startedAt = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
      try {
        f.state.capture = () => {
          clock.mockReturnValue(startedAt + 15)
        }
        expect(
          await f.query(f.request, { ...f.context, deadline: new Date(startedAt + 5).toISOString() }),
        ).toMatchObject({ ok: false, error: { code: 'timeout' } })
      } finally {
        clock.mockRestore()
      }
    } finally {
      await f.provider.close('shutdown')
    }
  })

  it('keeps current authority separate from the saved input and cannot revive disposed bindings', async () => {
    const f = await open(id)
    try {
      expect(await f.provider.drain('invalid', f.context)).toMatchObject({ ok: false })
      expect((await f.query()).ok).toBe(true)
      f.request.target.providerId = 'foreign'
      f.state.check = () => {
        f.request.target.providerId = f.factory.descriptor.providerId
      }
      expect(await f.query()).toMatchObject({ ok: false, error: { code: 'denied' } })
      f.state.check = () => {}
      f.state.capture = () => {
        f.state.allowed = false
      }
      expect(await f.query()).toMatchObject({ ok: false, error: { code: 'denied' } })
      f.state.allowed = true
      f.state.capture = () => {}
      expect(await f.provider.drain(f.context.deadline, f.context)).toMatchObject({
        ok: true,
        value: { state: 'drained' },
      })
      expect((await f.query()).ok).toBe(false)
      expect((await f.provider.ready(f.context)).ok).toBe(false)
      await f.provider.close('shutdown')
      expect((await f.provider.ready(f.context)).ok).toBe(false)
      expect((await f.query()).ok).toBe(false)
    } finally {
      await f.provider.close('shutdown')
    }
  })
  it('rechecks the captured source instead of a subsequently replaced owner snapshot', async () => {
    const f = await open(id)
    try {
      let revoked = false
      f.state.sourceCheck = (captured) => {
        f.state.available = !revoked || captured.snapshot !== 'fixture-snapshot'
        revoked = true
        f.source.snapshot = 'replacement-snapshot'
      }
      expect(await f.query()).toMatchObject({
        ok: false,
        error: { code: 'denied', detailCode: 'context_source_denied' },
      })
    } finally {
      await f.provider.close('shutdown')
    }
  })

  it('rejects unsupported paging and authority migration without dispatching anything', async () => {
    const f = await open(id)
    try {
      expect(await f.query({ ...f.request, page: { limit: 1 } })).toMatchObject({
        ok: false,
        error: { detailCode: 'context_pagination_unavailable' },
      })
      expect(f.factory.descriptor.operations.map((operation) => operation.method)).toEqual(['view'])
      expect(f.provider.actions).toBeUndefined()
      expect(
        await f.provider.maintenance?.({ ...f.request, method: 'authorityExport' }, f.context),
      ).toMatchObject({ ok: false, error: { detailCode: 'context_authority_transfer_unavailable' } })
    } finally {
      await f.provider.close('shutdown')
    }
  })
})
