import { createPreparedRegistry } from '@agnes/core'
import { canonicalJsonDigest, type DataRef } from '@agnes/protocol/runtime'
import { createModelSourceReader } from '../../../src/runtime/model/model-source-reader.js'
import { fixtureContext, fixtureFrame, fixturePorts } from '../model-source-fixture.js'

// Fresh process: only the handle reference arrives from the parent; nothing prepared travels with it.
const [refJson = ''] = process.argv.slice(2)
let network = 0
globalThis.fetch = (() => {
  network++
  return Promise.reject(new Error('the reader must not send anything'))
}) as typeof fetch
const ref = JSON.parse(refJson) as Extract<DataRef, { kind: 'inline' }>
const { ports } = fixturePorts()
const loaded = await createModelSourceReader({ ...ports, registry: createPreparedRegistry() }).load(
  ref,
  fixtureFrame(ref),
  fixtureContext(new AbortController().signal),
)
process.stdout.write(
  `${JSON.stringify(
    loaded.ok
      ? { ok: true, digest: canonicalJsonDigest(loaded.value as never), network }
      : { ok: false, detailCode: loaded.error.detailCode, network },
  )}\n`,
)
