import {
  ctx,
  haltAtStatement,
  hold,
  ok,
  openServices,
  owner,
  PUBLICATION,
  PUBLICATION_CONTENT,
  publishRequest,
  report,
  reserveRequest,
  upload,
} from './artifact-world.js'

/**
 * Drives one publication: reserve, upload, publish (pending-publish, promote, pin, ready). With a
 * pause point it reports that point and holds there for the parent to kill it; without one it
 * repeats every step from the start, which is how a restarted process recovers.
 */

const [dataDir, pauseAt] = process.argv.slice(2)
if (dataDir === undefined) throw new Error('usage: publication-child <dataDir> [pause point]')

const at = async (point: string, data: unknown) => {
  if (point === pauseAt) await hold(point, data)
}
// The ready record is updated first and its event inserted second, in one transaction.
if (pauseAt === 'ready-transaction') haltAtStatement(pauseAt, (sql) => sql.startsWith('INSERT INTO outbox'))

const services = openServices(dataDir, {
  actions: (blob) => ({
    async promote(request, context) {
      await at('pending-publish', null)
      const staged = await blob.promote(request, context)
      if (staged.ok) await at('promoted', staged.value)
      return staged
    },
    async pin(request, context) {
      const pinned = await blob.pin(request, context)
      if (pinned.ok) await at('pinned', pinned.value)
      return pinned
    },
  }),
})
const reserved = ok(
  await services.artifacts.reserve({ request: reserveRequest(PUBLICATION), owner: owner() }, ctx()),
)
report('reserved', reserved)
await at('reserved', reserved)
const source = await upload(services.blob, PUBLICATION_CONTENT, {
  staged: (session) => report('staged', session),
  chunk: (session) => at('uploading', session),
  sealed: (result) => report('sealed', result),
})
const ready = ok(
  await services.artifacts.publish({ request: publishRequest(PUBLICATION, source), owner: owner() }, ctx()),
)
await at('ready', ready)
services.close()
report('done', ready)
