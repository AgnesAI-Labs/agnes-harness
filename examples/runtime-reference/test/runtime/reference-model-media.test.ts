import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import { canonicalJsonDigest, type JsonValue, type MediaPlan } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  createReferenceModelAdapterFactory,
  type ReferenceModelSource,
} from '../../src/providers/model-adapter.js'
import { referenceModelFixture } from './reference-model-fixture.js'

const parameters = { kind: 'fixture' }
const plan = (fixture: Awaited<ReturnType<typeof referenceModelFixture>>, key = 'media:a'): MediaPlan => ({
  key,
  sourceRefs: [
    {
      kind: 'blob',
      value: {
        authorityId: 'authority',
        blobId: `blob-${key}`,
        digest: 'a'.repeat(64),
        bytes: 3,
        mediaType: 'image/png',
        pinId: 'pin',
      },
    },
  ],
  sourceDigest: 'b'.repeat(64),
  transformSchema: { typeId: 'fixture/transform@1', revision: 1, digest: 'c'.repeat(64) },
  parameters: {
    kind: 'inline',
    schema: { typeId: 'fixture/parameters@1', revision: 1, digest: 'd'.repeat(64) },
    value: parameters,
    digest: canonicalJsonDigest(parameters),
    bytes: 18,
  },
  targetFeatures: fixture.source.prepared.target.features,
  provider: { bindingId: 'media', providerId: 'provider', contract: 'agh.media', logicalName: 'default' },
})
const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }
const entry = (media: MediaPlan, usageIds: string[] = [], imageCount = 1) => ({
  planKey: media.key,
  planDigest: canonicalJsonDigest(media as never),
  usageIds,
  imageCount,
})

/** Runs the reference adapter on a source built from the fixture's, without changing what it pins. */
async function run(
  shape: (
    fixture: Awaited<ReturnType<typeof referenceModelFixture>>,
  ) => Partial<ReferenceModelSource> & { plans?: MediaPlan[] },
) {
  const fixture = await referenceModelFixture(
    'http://127.0.0.1:1/v1',
    `${process.cwd()}/no-such-receipt.json`,
  )
  const { plans, ...rest } = shape(fixture)
  const source: ReferenceModelSource = {
    ...fixture.source,
    prepared: { ...fixture.source.prepared, mediaPlans: plans ?? [] },
    ...rest,
  }
  const deployment = {
    ...fixture.deployment,
    async load(...args: Parameters<typeof fixture.deployment.load>) {
      const loaded = await fixture.deployment.load(...args)
      return loaded.ok ? { ok: true as const, value: source } : loaded
    },
    current: (
      _s: ReferenceModelSource,
      f: Parameters<typeof fixture.deployment.current>[1],
      c: Parameters<typeof fixture.deployment.current>[2],
    ) => fixture.deployment.current(fixture.source, f, c),
  }
  const config = deployment.config.encode({})
  if (!config.ok) throw new Error('config')
  const provider = await createReferenceModelAdapterFactory(deployment).create(
    config.value,
    createTestServiceContainer().dependencies,
    {
      instanceId: 'media-instance',
      scope: fixture.context.scope,
      bindingId: fixture.context.bindingId,
      signal: new AbortController().signal,
    },
  )
  const ready = await provider.ready(fixture.context)
  if (!ready.ok) throw new Error('provider')
  const action = await provider.actions?.invoke?.create({
    instanceId: 'leaf',
    actionId: fixture.frame.actionId,
    runId: fixture.frame.runId,
    bindingId: fixture.context.bindingId,
    scope: {
      ...fixture.context.scope,
      kind: 'action',
      workspaceId: 'workspace',
      sessionId: 'session',
      runId: 'run',
      actionId: 'action',
    },
    signal: new AbortController().signal,
  })
  if (!action || action.kind !== 'leaf') throw new Error('leaf')
  const actionReady = await action.ready(fixture.context)
  if (!actionReady.ok) throw new Error('action')
  const result = await action.execute(fixture.frame, fixture.call)
  await provider.close('shutdown')
  return { result, sends: fixture.sends() }
}
const withImages = (count: number): JsonValue => ({
  model: 'fixture-model',
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }, ...Array.from({ length: count }, () => image)],
    },
  ],
  max_completion_tokens: 32,
  stream: true,
  stream_options: { include_usage: true },
})
const refused = (outcome: Awaited<ReturnType<typeof run>>) =>
  outcome.result.outcome === 'failed' && outcome.result.error?.code === 'invalid_input' && outcome.sends === 0

describe('reference model adapter media check', () => {
  it('sends a request that carries exactly the evidenced media', async () => {
    const outcome = await run((fixture) => {
      const media = plan(fixture)
      return { plans: [media], media: [entry(media)], body: withImages(1) }
    })
    expect(outcome.sends).toBe(1)
  })

  it('refuses locked plans without evidence', async () => {
    expect(refused(await run((fixture) => ({ plans: [plan(fixture)], body: withImages(1) })))).toBe(true)
  })

  it('refuses an image nobody planned', async () => {
    expect(refused(await run(() => ({ body: withImages(1) })))).toBe(true)
  })

  it('refuses a second image the evidence never named', async () => {
    expect(
      refused(
        await run((fixture) => {
          const media = plan(fixture)
          return { plans: [media], media: [entry(media)], body: withImages(2) }
        }),
      ),
    ).toBe(true)
  })

  it('refuses usage counted by two plans', async () => {
    expect(
      refused(
        await run((fixture) => {
          const one = plan(fixture, 'media:a')
          const two = plan(fixture, 'media:b')
          return { plans: [one, two], media: [entry(one, ['u']), entry(two, ['u'])], body: withImages(2) }
        }),
      ),
    ).toBe(true)
  })

  it('refuses a plan made for other target features', async () => {
    expect(
      refused(
        await run((fixture) => {
          const media = {
            ...plan(fixture),
            targetFeatures: { ...fixture.source.prepared.target.features, input: ['text', 'image'] as const },
          }
          return { plans: [media as MediaPlan], media: [entry(media as MediaPlan)], body: withImages(1) }
        }),
      ),
    ).toBe(true)
  })
  it('refuses evidence for another plan digest', async () => {
    expect(
      refused(
        await run((fixture) => {
          const media = plan(fixture)
          return {
            plans: [media],
            media: [{ ...entry(media), planDigest: 'f'.repeat(64) }],
            body: withImages(1),
          }
        }),
      ),
    ).toBe(true)
  })
})
