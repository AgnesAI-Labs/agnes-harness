import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  type NetworkScenarioEvidence,
  registerNetworkContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/network.js'
import type {
  BuildIdentity,
  ScenarioName,
} from '../../../../packages/extension-api/testkit/runtime/evidence.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import {
  coldModelEgress,
  modelFixture,
  type Recipe,
} from '../../../../packages/host/test/runtime/model-egress-fixture.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'

/** Local companion evidence only; this does not qualify a secret-bearing C21 wire API. */
export function bindModelEgressConformance(
  harness: ConformanceHarness,
  command: string,
  kind: Recipe,
  provider: string,
  build: BuildIdentity,
) {
  const module =
    kind === 'default'
      ? '../../../../packages/host/src/runtime/model/model-egress.ts'
      : '../../../../examples/runtime-reference/src/providers/model-egress.ts'
  const providerDigest = createHash('sha256')
    .update(readFileSync(new URL(module, import.meta.url)))
    .digest('hex')
  async function scenario(name: ScenarioName): Promise<NetworkScenarioEvidence> {
    if (name === 'recover') {
      assert.deepEqual(await coldModelEgress(kind), {
        initialStatus: 200,
        refusal: 'denied/model_egress_credential',
        requests: 1,
      })
    } else {
      const f = await modelFixture(kind)
      try {
        const port = f.port()
        if (name === 'select') {
          assert.equal((await port.resolveCredential('local-model', f.call.signal)) === f.key, true)
          assert.equal(
            await f.code(f.port({ current: undefined }).fetch(f.request())),
            'denied/model_egress_owner',
          )
        } else if (name === 'normal') {
          const reply = await port.fetch(f.request())
          assert.equal(reply.status, 200)
          assert.equal(await reply.text(), 'data: {"answer":"local-answer"}\n\n')
          assert.deepEqual(
            f.observations.map((item) => item.correctKey),
            [true],
          )
        } else if (name === 'deny') {
          assert.equal(await f.code(port.fetch(f.request(`${f.url}/other`))), 'denied/model_egress_target')
          f.retire()
          assert.equal(await f.code(port.fetch(f.request())), 'denied/model_egress_binding')
          assert.equal(f.observations.length, 0)
        } else if (name === 'cancel') {
          const abort = new AbortController()
          abort.abort()
          assert.equal(
            await f.code(port.fetch(f.request(f.url, { signal: abort.signal }))),
            'cancelled/model_egress_cancelled',
          )
          assert.equal(f.observations.length, 0)
        } else {
          await port.close()
          assert.equal(await f.code(port.fetch(f.request())), 'denied/model_egress_closed')
          assert.equal(f.observations.length, 0)
        }
      } finally {
        await f.close()
      }
    }
    return {
      passed: true,
      providerDigest,
      configDigest: canonicalJsonDigest({
        recipe: 'model-egress-local-candidate',
        kind,
        bound: 'model',
        scenario: name,
      }),
      releaseSetDigest: canonicalJsonDigest({ build: build.buildDigest, providerDigest }),
      detail:
        name === 'recover'
          ? 'fresh process: stored key then durable revoke; no replay owner qualification'
          : name,
    }
  }
  registerNetworkContract(harness, {
    command,
    build,
    providerId: provider,
    sources: [
      {
        recipe: 'model-egress-local-candidate',
        features: [],
        select: () => scenario('select'),
        normal: () => scenario('normal'),
        deny: () => scenario('deny'),
        cancel: () => scenario('cancel'),
        recover: () => scenario('recover'),
        dispose: () => scenario('dispose'),
      },
    ],
  })
}
