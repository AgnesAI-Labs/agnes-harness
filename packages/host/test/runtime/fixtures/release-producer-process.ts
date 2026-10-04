import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createReleaseProducer } from '../../../src/runtime/assembly/release-producer.js'
import { producerTestContext } from './release-producer-input.js'
import { producerCommitFixture } from './release-producer-port.js'

const [mode, root] = process.argv.slice(2)
if (!root || (mode !== 'publish' && mode !== 'staged' && mode !== 'recover'))
  throw new Error('fixture arguments')
const lock = JSON.parse(readFileSync(join(root, 'child-lock.json'), 'utf8'))
const database = producerCommitFixture(join(root, 'publication.sqlite'), lock.producer, {
  readonly: mode === 'recover',
  ...(mode === 'staged'
    ? {
        beforeCommit() {
          process.send?.({ staged: true, pid: process.pid })
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
        },
      }
    : {}),
  ...(mode === 'publish'
    ? {
        afterCommit() {
          process.send?.({ committed: true, pid: process.pid })
          // SIGKILL lands after the atomic commit, before its response or admission callback.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
        },
      }
    : {}),
})
const producer = createReleaseProducer(join(root, 'deployment'), database.port)
try {
  const result =
    mode !== 'recover'
      ? await producer.publish(producerTestContext())
      : await producer.recover(lock.transactionId, producerTestContext())
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('fixture IPC missing'))
    process.send({ result, changes: database.changes(), pid: process.pid }, (error) =>
      error ? reject(error) : resolve(),
    )
  })
} finally {
  await producer.dispose()
  database.close()
  process.disconnect?.()
}
