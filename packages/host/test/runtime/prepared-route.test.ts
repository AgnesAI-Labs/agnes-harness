import { runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { capturePreparedRoute, type PreparedRouteSource } from '../../src/runtime/routing/prepared-route.js'

const fixtureUrl = new URL('../../../ai/test/runtime/model-fixture.ts', import.meta.url).href
const factoryUrl = new URL('../../../ai/src/runtime/providers/model-adapter.ts', import.meta.url).href
for (const scenario of [
  'fixed',
  'changed-price',
  'changed-transform',
  'forged-bytes',
  'context-mutation',
  'owner-denied',
] as const) {
  it(`captures actual immutable route provenance with a restricted owner: ${scenario}`, async () => {
    const { modelFixture } = await import(fixtureUrl)
    const { createModelAdapterFactory } = await import(factoryUrl)
    const fixture = await modelFixture('openai-completions', 'http://127.0.0.1:1/v1', 'unused-receipt')
    try {
      const definition = runtimeAuthorSchemas.StandardToolOutput.encode({
        content: [],
        structured: { providerId: fixture.source.prepared.target.adapter.providerId },
      })
      if (!definition.ok) throw new Error('Missing actual fixture definition codec')
      const source: PreparedRouteSource = {
        route: structuredClone(fixture.source.prepared.target),
        definition: structuredClone(definition.value),
        descriptor: createModelAdapterFactory(fixture.deployment).descriptor,
        transformDigest: canonicalJsonDigest(fixture.source.prepared.mediaPlans),
        // A genuine fixture-owned reference tracks this isolated provenance test; no resource write.
        preparedSchema: fixture.source.prepared.view.schema,
      }
      if (scenario === 'changed-price') source.route.priceVersion = 'other-price'
      if (scenario === 'changed-transform') Reflect.set(source, 'transformDigest', 'f'.repeat(64))
      if (scenario === 'forged-bytes' && source.definition.kind === 'inline') source.definition.bytes++
      const result = capturePreparedRoute(
        fixture.source.prepared,
        source,
        {
          current(candidate, context) {
            if (scenario === 'context-mutation') Reflect.set(context, 'authorizationRef', 'changed-owner')
            return scenario !== 'owner-denied' && candidate === source && context === fixture.context
          },
        },
        fixture.context,
      )
      expect(result.ok).toBe(scenario === 'fixed')
      if (result.ok) {
        expect(result.value.priceVersion).toBe('fixture-price-1')
        expect(result.value.routeDigest).toBe(canonicalJsonDigest(fixture.source.prepared.target))
        expect(result.value.definitionDigest).toBe(
          definition.value.kind === 'inline' ? definition.value.digest : definition.value.blob.digest,
        )
        expect(Object.isFrozen(result.value)).toBe(true)
      }
    } finally {
      await fixture.provider.close('shutdown')
    }
  })
}
