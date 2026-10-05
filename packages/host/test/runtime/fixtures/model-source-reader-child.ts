import { canonicalJsonDigest, type DataRef } from '@agnes/protocol/runtime'
import { openModelCaptureStore } from '../../../src/runtime/model/model-capture-store.js'
import { createModelSourceReader } from '../../../src/runtime/model/model-source-reader.js'
import { fixtureContext, fixtureFrame, fixturePorts } from '../model-source-fixture.js'

// Fresh process: only the store file and the prepared reference arrive from the parent.
const [storePath, refJson] = process.argv.slice(2)
let network = 0
globalThis.fetch = (() => {
  network++
  return Promise.reject(new Error('the reader must not send anything'))
}) as typeof fetch
const store = openModelCaptureStore(storePath)
const ref = JSON.parse(refJson) as Extract<DataRef, { kind: 'inline' }>
const { ports } = fixturePorts({ captures: { read: (digest) => store.read(digest) } })
const loaded = await createModelSourceReader(ports).load(
  ref,
  fixtureFrame(ref),
  fixtureContext(new AbortController().signal),
)
store.close()
process.stdout.write(
  `${JSON.stringify(
    loaded.ok
      ? { ok: true, digest: canonicalJsonDigest(loaded.value as never), network }
      : { ok: false, detailCode: loaded.error.detailCode, network },
  )}\n`,
)
