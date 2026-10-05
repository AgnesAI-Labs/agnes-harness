import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tckFixture } from '../../../../packages/host/test/runtime/identity-conformance-fixture.js'

const [providerId, directory, mode] = process.argv.slice(2)
if (
  !directory ||
  (providerId !== 'default' && providerId !== 'reference') ||
  (mode !== 'hold' && mode !== 'once')
)
  throw new Error('Invalid Identity cold fixture arguments')
const path = join(directory, 'owner.sqlite')
const credentialPath = join(directory, 'credential.json')
let priorInstances = 0
if (mode === 'once') {
  const database = new DatabaseSync(path)
  try {
    const table = providerId === 'default' ? 'runtime_identity_instances' : 'reference_identity'
    priorInstances = Number((database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
  } finally {
    database.close()
  }
  if (priorInstances !== 1)
    throw new Error('Original Identity instance was not retained across process death')
}
const state: { credential?: { kind: 'source-auth'; timestamp: number; nonce: string; signature: string } } =
  mode === 'once' ? { credential: JSON.parse(readFileSync(credentialPath, 'utf8')) } : {}
const fixture = await tckFixture(providerId, path, state)
const service = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.context)
try {
  if (!service.ingress || !service.query) throw new Error('Identity methods are absent')
  if (!(await service.ready(fixture.administrativeContext)).ok)
    throw new Error('Identity provider did not become ready')
  const signal = new AbortController().signal
  let replayDenied = false
  if (mode === 'once') {
    const replay = await fixture.ingress('source-auth', signal, true)
    replayDenied = !(await service.ingress(replay.operation, replay.context)).ok
    if (!replayDenied) throw new Error('Original source-auth nonce replay was accepted')
  }
  const input = await fixture.ingress('source-auth', signal, false)
  const result = await service.ingress(input.operation, input.context)
  if (!result.ok) throw new Error(`Fresh source-auth authentication failed: ${result.error.detailCode}`)
  const context = await fixture.current(result.value, signal)
  if (context.signal.aborted) throw new Error('Fresh current Identity context is cancelled')
  if (mode === 'hold') {
    if (!state.credential) throw new Error('Original source-auth credential was not captured')
    writeFileSync(credentialPath, JSON.stringify(state.credential), { mode: 0o600 })
  }
  process.stdout.write(
    `${JSON.stringify({ pid: process.pid, priorInstances, replayDenied, accepted: true })}\n`,
  )
  if (mode === 'hold') setInterval(() => {}, 1000)
} finally {
  if (mode === 'once') {
    await service.close('shutdown')
    await fixture.dispose()
  }
}
