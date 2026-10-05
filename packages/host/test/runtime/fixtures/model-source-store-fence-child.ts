import { openModelSourceStore } from '../../../src/runtime/model/model-source-store.js'
import { BODY_DIGEST, frameFor, registryOf } from '../model-source-store-fixture.js'

const [path] = process.argv.slice(2)
if (!path) throw Error('Store path required')
const frame = frameFor('1')
const store = openModelSourceStore({ path, calls: registryOf(frame), soleSendFence: true })
process.stdout.write(JSON.stringify({ fenced: store.fence(frame, BODY_DIGEST) }))
store.close()
