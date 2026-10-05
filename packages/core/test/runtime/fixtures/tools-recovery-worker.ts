import { readFileSync, writeFileSync } from 'node:fs'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { openToolsFixture } from '../tools-fixture.js'

const [mode, sourceFile, resultFile] = process.argv.slice(2)
if (!mode || !['first', 'recover'].includes(mode) || !sourceFile || !resultFile)
  throw new Error('Tools cold worker arguments')
const source = JSON.parse(readFileSync(sourceFile, 'utf8')) as {
  kind: 'default' | 'reference'
  text: string
  digest: string
}
if (canonicalJsonDigest({ kind: source.kind, text: source.text }) !== source.digest)
  throw new Error('Tools cold source changed')
const fixture = await openToolsFixture(source.kind, source.text)
const provider = await fixture.factory.create(
  fixture.configuration,
  fixture.dependencies,
  fixture.factoryContext,
)
const actionFactory = provider.actions?.invoke
if (!actionFactory) throw new Error('Tools cold action unavailable')
const action = await actionFactory.create({
  instanceId: 'tools-instance',
  actionId: fixture.frame.actionId,
  runId: fixture.frame.runId,
  bindingId: fixture.frame.bindingId,
  scope: fixture.call.scope,
  signal: fixture.call.signal,
})
if (action.kind !== 'leaf') throw new Error('Tools cold leaf unavailable')
const result = await action.execute(fixture.frame, fixture.actionContext)
if (result.outcome !== 'succeeded' || fixture.effectsCount())
  throw new Error(`Tools cold recomputation refused: ${result.error?.detailCode}`)
const proof = {
  result,
  inputDigest: fixture.frame.inputDigest,
  configurationDigest:
    fixture.configuration.kind === 'inline'
      ? fixture.configuration.digest
      : fixture.configuration.blob.digest,
  definitionDigest: canonicalJsonDigest(fixture.definition),
}
if (mode === 'first') writeFileSync(resultFile, JSON.stringify(proof), { flag: 'wx' })
else if (canonicalJsonDigest(JSON.parse(readFileSync(resultFile, 'utf8'))) !== canonicalJsonDigest(proof))
  throw new Error('Tools cold fixed result differs')
process.send?.({
  phase: mode,
  pid: process.pid,
  proof: canonicalJsonDigest(proof),
  inputDigest: proof.inputDigest,
  configurationDigest: proof.configurationDigest,
})
// Parent kills the actual provider process; no orderly close or in-memory restart is used.
setInterval(() => {}, 1000)
