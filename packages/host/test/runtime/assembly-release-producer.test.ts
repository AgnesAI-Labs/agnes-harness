import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProtectedDeployment } from '../../src/runtime/assembly/protected-deployment.js'
import {
  captureReleaseProducerPublication,
  createReleaseProducer,
} from '../../src/runtime/assembly/release-producer.js'
import { producerFactsRef } from '../../src/runtime/assembly/release-producer-source.js'
import {
  assemblyDigest,
  assemblyGraphDigest,
  constructReleaseSet,
  releasePlanFingerprint,
  releaseSetDigest,
} from '../../src/runtime/assembly/release-set.js'
import {
  producerDeploymentFixture,
  producerTestContext,
  writeProducerJson,
} from './fixtures/release-producer-input.js'
import { producerCommitFixture } from './fixtures/release-producer-port.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function setup(options: Parameters<typeof producerCommitFixture>[2] = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'release-producer-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const deployment = join(root, 'deployment')
  // The deployment root is private, and the database is outside its source inventory.
  const { mkdirSync } = await import('node:fs')
  mkdirSync(deployment, { mode: 0o700 })
  const fixture = await producerDeploymentFixture(deployment)
  const binding = fixture.release.bindings.find((row) => row.descriptor.contract === 'agh.assembly')?.binding
  if (!binding) throw new Error('producer missing')
  const database = producerCommitFixture(join(root, 'publication.sqlite'), binding, options)
  cleanups.push(() => database.close())
  const producer = createReleaseProducer(deployment, database.port)
  cleanups.push(() => producer.dispose())
  return { root, deployment, fixture, database, producer, binding }
}

describe.runIf(process.platform !== 'win32')('private release source producer', () => {
  it('resolves protected originals, commits three CAS members, preserves receipt and cold reads without source I/O', async () => {
    const { root, deployment, fixture, database, producer, binding } = await setup({ reverseReceipt: true })
    const commit = database.port.store.commit
    database.port.store.commit = async (request, context) => {
      expect(() => captureReleaseProducerPublication(structuredClone(request), context)).toThrow()
      expect(() => captureReleaseProducerPublication(request, { ...context })).toThrow()
      const proof = captureReleaseProducerPublication(request, context)
      expect(proof.qualifiedUntil).toBe('2030-01-01T00:00:00Z')
      return commit(request, context)
    }
    let accepted: unknown
    const originalAccept = database.port.acceptPublishedAdmissionRelease
    database.port.acceptPublishedAdmissionRelease = async (receipt, context) => {
      await originalAccept(receipt, context)
      accepted = receipt
    }
    const result = await producer.publish(producerTestContext())
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.receipt).toBe(accepted)
    expect(result.value.receipt.revisions[0]?.recordId).toBe(`release:${fixture.release.releaseSetId}`)
    const facts = result.value.facts
    expect(facts.release).toEqual(fixture.release)
    expect(facts.configuration).toEqual({ request: fixture.configRequest, result: fixture.configuration })
    expect(facts.packages.result).toEqual(fixture.resolution)
    expect(facts.packages.verified).toHaveLength(fixture.release.packages.length)
    expect(facts.binding.providers).toEqual(fixture.release.bindings)
    expect(facts.binding.releaseSetId).toBe(fixture.release.releaseSetId)
    for (const pkg of facts.release.packages) expect(facts.requiredDigests).toContain(pkg.digest)
    expect(facts.requiredDigests).toContain(sha(readFileSync(join(deployment, 'config-request.json'))))
    const original = await database.port.readPublication(
      result.value.receipt.transactionId,
      producerTestContext(),
    )
    expect(
      original?.request.mutations.map((row) => [
        row.recordId,
        row.expectedRevision,
        row.next.revision,
        row.next.writerEpoch,
      ]),
    ).toEqual([
      ['fixture-current-head', null, 1, 1],
      [`release-route:${fixture.plan.routeId}`, null, 1, 1],
      [`release:${fixture.release.releaseSetId}`, null, 1, 1],
    ])
    const writes = database.changes()
    const cached = readdirSync(deployment).sort()
    expect((await producer.publish(producerTestContext())).ok).toBe(true)
    expect(database.changes()).toBe(writes)
    expect(readdirSync(deployment).sort()).toEqual(cached)
    if (!original) throw new Error('original missing')
    expect(() =>
      captureReleaseProducerPublication(structuredClone(original.request), producerTestContext()),
    ).toThrow()
    await expect(
      database.port.acceptPublishedAdmissionRelease(
        structuredClone(result.value.receipt),
        producerTestContext(),
      ),
    ).rejects.toThrow('foreign_native_receipt')
    await producer.dispose()
    database.close()
    rmSync(deployment, { recursive: true })
    const cold = producerCommitFixture(join(root, 'publication.sqlite'), binding, { readonly: true })
    cleanups.push(() => cold.close())
    const recovered = createReleaseProducer(deployment, cold.port)
    cleanups.push(() => recovered.dispose())
    const read = await recovered.recover(result.value.receipt.transactionId, producerTestContext())
    expect(read.ok, JSON.stringify(read)).toBe(true)
    if (read.ok) expect(read.value.facts).toEqual(facts)
    expect(cold.changes()).toBe(0)
  })

  it.each(['config-request.json', 'package-request.json', 'release-lock.json'])(
    'refuses missing %s with zero writes',
    async (name) => {
      const { deployment, database, producer } = await setup()
      rmSync(join(deployment, name))
      expect((await producer.publish(producerTestContext())).ok).toBe(false)
      expect(database.changes()).toBe(0)
    },
  )

  it.each(['release digest', 'package bytes', 'candidate JSON', 'caller config'])(
    'refuses substituted %s with zero writes',
    async (kind) => {
      const { deployment, fixture, database, producer } = await setup()
      if (kind === 'release digest') {
        const lock = JSON.parse(readFileSync(join(deployment, 'release-lock.json'), 'utf8'))
        lock.plan.targetReleaseSet.releaseSetId = 'f'.repeat(64)
        writeProducerJson(deployment, 'release-lock.json', lock)
      } else if (kind === 'package bytes') {
        writeFileSync(join(deployment, 'packages/backend/acme.release/1.0.0/runtime.js'), 'substituted', {
          mode: 0o600,
        })
      } else if (kind === 'candidate JSON') {
        writeProducerJson(deployment, 'release-lock.json', { candidate: fixture.input })
      } else {
        writeProducerJson(deployment, 'config-request.json', { configuration: fixture.configuration })
      }
      expect((await producer.publish(producerTestContext())).ok).toBe(false)
      expect(database.changes()).toBe(0)
    },
  )

  it('refuses a different protected fingerprint for the same transaction without writes', async () => {
    const { deployment, fixture, database, producer } = await setup()
    const first = await producer.publish(producerTestContext())
    expect(first.ok, JSON.stringify(first)).toBe(true)
    const writes = database.changes()
    writeProducerJson(deployment, 'binding-policy.json', { ...fixture.policy, bindingId: 'changed-binding' })
    const replay = await producer.publish(producerTestContext())
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.error.detailCode).toBe('producer_fingerprint_conflict')
    expect(database.changes()).toBe(writes)
  })

  it.each(['selected descriptor', 'applied configuration', 'missing release member', 'unpublished schema'])(
    'refuses a resealed %s substitution with zero writes',
    async (kind) => {
      const { deployment, database, producer } = await setup()
      const lock = JSON.parse(readFileSync(join(deployment, 'release-lock.json'), 'utf8'))
      if (kind === 'selected descriptor') {
        lock.plan.targetReleaseSet.bindings[0].descriptor.recovery = 'R2'
        lock.graph.bindings[0].descriptor.recovery = 'R2'
      } else if (kind === 'applied configuration') {
        const request = JSON.parse(readFileSync(join(deployment, 'config-request.json'), 'utf8'))
        request.profiles[0].document.id = 'substituted-profile'
        request.profiles[0].source.digest = createHash('sha256')
          .update((await import('@agnes/protocol')).jcs(request.profiles[0].document))
          .digest('hex')
        writeProducerJson(deployment, 'config-request.json', request)
      } else if (kind === 'unpublished schema') {
        const ref = lock.plan.targetReleaseSet.schemasRef
        ref.value.schemas.push({
          ownerPackageId: 'acme.release',
          name: 'Added',
          typeId: 'acme.release/added@1',
          revision: 1,
          document: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $ref: '#/$defs/Added',
            $defs: { Added: { type: 'object', properties: {}, required: [], additionalProperties: false } },
          },
        })
        ref.digest = assemblyDigest(ref.value)
        ref.bytes = Buffer.byteLength((await import('@agnes/protocol')).jcs(ref.value))
      } else {
        delete lock.plan.targetReleaseSet.recoveryManifestRef
      }
      if (kind === 'selected descriptor' || kind === 'unpublished schema') {
        lock.plan.targetReleaseSet.releaseSetId = releaseSetDigest(lock.plan.targetReleaseSet)
        lock.graph.digest = assemblyGraphDigest(lock.graph)
        lock.plan.planFingerprint = releasePlanFingerprint(lock.plan)
      }
      writeProducerJson(deployment, 'release-lock.json', lock)
      const result = await producer.publish(producerTestContext())
      expect(result.ok).toBe(false)
      if (!result.ok && kind === 'selected descriptor')
        expect(result.error.detailCode).toBe('selected_descriptor_mismatch')
      if (!result.ok && kind === 'unpublished schema')
        expect(result.error.detailCode).toBe('schema_source_mismatch')
      expect(database.changes()).toBe(0)
    },
  )

  it.each(['changed source', 'expired qualification', 'cancelled commit'])(
    'refuses %s at the preClock seam without writes',
    async (kind) => {
      const { deployment, database, producer } = await setup()
      const cancel = new AbortController()
      const commit = database.port.store.commit
      database.port.store.commit = async (request, context) => {
        if (kind === 'changed source')
          writeFileSync(join(deployment, 'config-request.json'), '{}', { mode: 0o600 })
        else if (kind === 'expired qualification') database.setNow('2026-10-03T00:02:00Z')
        else cancel.abort()
        return commit(request, context)
      }
      const result = await producer.publish({
        ...producerTestContext(),
        deadline: '2026-10-03T00:01:00Z',
        signal: cancel.signal,
      })
      expect(result.ok).toBe(false)
      if (!result.ok)
        expect(result.error.detailCode).toBe(
          kind === 'changed source'
            ? 'deployment_source_changed'
            : kind === 'expired qualification'
              ? 'producer_qualification_expired'
              : 'producer_cancelled',
        )
      expect(database.changes()).toBe(0)
    },
  )

  it('refuses a missing original member on cold read without replacing it', async () => {
    const { database, producer } = await setup()
    const result = await producer.publish(producerTestContext())
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    const readOriginal = database.port.readPublication
    database.port.readPublication = async (id, context) => {
      const original = await readOriginal(id, context)
      return (
        original && {
          ...original,
          source: producerFactsRef({
            ...result.value.facts,
            packages: { ...result.value.facts.packages, verified: [] },
          }),
        }
      )
    }
    const before = database.changes()
    const missingSnapshot = await producer.recover(result.value.receipt.transactionId, producerTestContext())
    expect(missingSnapshot.ok).toBe(false)
    if (!missingSnapshot.ok) expect(missingSnapshot.error.detailCode).toBe('producer_source_mismatch')
    expect(database.changes()).toBe(before)
    database.port.readPublication = readOriginal
    database.db.prepare('DELETE FROM records WHERE id=?').run('fixture-current-head')
    const writes = database.changes()
    expect((await producer.recover(result.value.receipt.transactionId, producerTestContext())).ok).toBe(false)
    expect(database.changes()).toBe(writes)
  })

  it('recovers a lost commit response using only the persisted original', async () => {
    const { database, producer } = await setup({
      afterCommit() {
        throw new Error('lost native response')
      },
    })
    const result = await producer.publish(producerTestContext())
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(database.changes()).toBe(4)
  })

  it('keeps production ready closed, fixture parsing unchanged, and denies missing ports, cancelled or expired contexts', async () => {
    const { deployment, fixture, database, producer } = await setup()
    const missing = createReleaseProducer(deployment)
    const ready = await missing.ready()
    expect(ready.ok).toBe(false)
    if (!ready.ok) expect(ready.error.detailCode).toBe('producer_commit_port_missing')
    expect((await missing.publish(producerTestContext())).ok).toBe(false)
    const tentative = await producer.ready()
    expect(tentative.ok).toBe(false)
    if (!tentative.ok) expect(tentative.error.detailCode).toBe('producer_codec_confirmation_pending')
    const cancel = new AbortController()
    cancel.abort()
    expect((await producer.publish({ ...producerTestContext(), signal: cancel.signal })).ok).toBe(false)
    database.setNow('2031-01-01T00:00:00Z')
    expect((await producer.publish(producerTestContext())).ok).toBe(false)
    expect(database.changes()).toBe(0)
    expect(
      constructReleaseSet({ ...fixture.input, fixture: { ...fixture.input.fixture, kind: 'production' } }).ok,
    ).toBe(false)
    await missing.dispose()
    await producer.dispose()
    expect((await producer.publish(producerTestContext())).ok).toBe(false)
  })

  it('refuses changed protected files, added package entries, symlinks and permissive ownership paths', async () => {
    const { deployment } = await setup()
    const observed = new ProtectedDeployment(deployment)
    observed.scan('packages/backend')
    writeFileSync(join(deployment, 'packages/backend/new-file'), 'added', { mode: 0o600 })
    expect(() => observed.preClock()).toThrow('Release planning refused')
    rmSync(join(deployment, 'packages/backend/new-file'))
    observed.read('config-request.json')
    writeFileSync(join(deployment, 'config-request.json'), '{}', { mode: 0o600 })
    expect(() => observed.preClock()).toThrow('Release planning refused')
    symlinkSync('config-request.json', join(deployment, 'link.json'))
    expect(() => observed.read('link.json')).toThrow()
    chmodSync(join(deployment, 'config-request.json'), 0o644)
    expect(() => observed.read('config-request.json')).toThrow('Release planning refused')
  })
})

it.runIf(process.platform === 'win32')('refuses a deployment without POSIX source ownership', () => {
  expect(() => new ProtectedDeployment(tmpdir())).toThrow('Release planning refused')
})
