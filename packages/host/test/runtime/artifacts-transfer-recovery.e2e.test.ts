import { cpSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import type { JsonValue } from '@agnes/protocol/runtime'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import { indexDigest } from '../../src/runtime/migration/export-index.js'
import type { ArtifactsService } from '../../src/runtime/providers/artifacts.js'
import {
  BLOB_BINDING,
  type Child,
  ctx,
  MIB,
  ok,
  owner,
  patternDigest,
  publishRequest,
  reserveRequest,
  SCOPE,
  type Services,
  startChild,
  upload,
} from './fixtures/artifact-world.js'
import {
  type Cohort,
  call,
  type Directory,
  MAINTAINER,
  openCohort,
  PARTS_KEPT,
  type Service,
  type Step,
  sides,
  UPGRADE,
} from './fixtures/blob-transfer-world.js'

const COHORT = 'c'.repeat(64)
const EXPECTED = { authorityId: 'artifacts-authority', tenantId: 'tenant-1', authorityEpoch: 1 }
const AUTHORITIES: Record<Service, { authorityId: string; binding: Wire.BindingRef }> = {
  blob: { authorityId: 'blob-authority', binding: BLOB_BINDING },
  artifacts: {
    authorityId: 'artifacts-authority',
    binding: {
      bindingId: 'artifacts-1',
      contract: 'agh.artifacts',
      logicalName: 'default',
      providerId: 'agh.artifacts.default',
    },
  },
}
/** The blob service moves first, so the artifacts' content is on the target when they are verified. */
const BLOB_FIRST: readonly Step[] = ['fence', 'export', 'import', 'verify']
const TRANSFER: readonly Step[] = ['fence', 'export', 'import', 'verify', 'activate']
const ABORTED: readonly Step[] = ['fence', 'export', 'import', 'abort']
const BYTES = 1000

type Done = Partial<Record<Step, unknown>>

/** What a process opening the cohort can see of the artifacts stores. */
type Seen = {
  source: Wire.AuthorityTransferProbe
  target: Wire.AuthorityTransferProbe
  /** A reservation replayed through each side's write gate: `ok` while it serves, the refusal otherwise. */
  serving: Record<'source' | 'target', string>
  /** A page of the source's export manifest, or the refusal. */
  exported: string
  /** Business rows the target holds. */
  rows: number
}

/**
 * Each point is where the step's process is killed. A point after the step's commit must already
 * show what a retry of the step shows; any other point must show what the stores held before the
 * step, except for the rows the import committed on the target.
 */
const POINTS: { point: string; step: Step; committed: boolean; imported?: 'none' | 'parts' | 'all' }[] = [
  { point: 'fence-open', step: 'fence', committed: false },
  { point: 'fence-committed', step: 'fence', committed: true },
  { point: 'export-staged', step: 'export', committed: false },
  { point: 'export-partial', step: 'export', committed: false },
  { point: 'export-cleared', step: 'export', committed: false },
  { point: 'export-recorded', step: 'export', committed: true },
  { point: 'import-recorded', step: 'import', committed: false, imported: 'none' },
  { point: 'import-asset', step: 'import', committed: false, imported: 'none' },
  { point: 'import-part-rows', step: 'import', committed: false, imported: 'parts' },
  { point: 'import-part-committed', step: 'import', committed: false, imported: 'parts' },
  { point: 'import-walked', step: 'import', committed: false, imported: 'all' },
  { point: 'verify-reading', step: 'verify', committed: false },
  { point: 'activate-open', step: 'activate', committed: false },
  { point: 'activate-committed', step: 'activate', committed: true },
  { point: 'abort-open', step: 'abort', committed: false },
  { point: 'abort-committed', step: 'abort', committed: true },
]

const scratch: string[] = []
const children: Child[] = []
let template = ''
let seeded: Awaited<ReturnType<typeof populate>>
/** What the source served before the transfer; the side left serving must serve the same. */
let original: Awaited<ReturnType<typeof served>>
/** The digest of the export manifest every run of this dataset must produce. */
let manifest = ''
/** The manifest's parts in order, as a clean export lists them. */
let parts: Wire.AuthorityExportPart[] = []
let clean: Record<'transfer' | 'abort', Awaited<ReturnType<typeof run>>>

afterEach(async () => {
  for (const child of children.splice(0)) await child.kill()
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true })
})
afterAll(async () => {
  if (template) await rm(template, { recursive: true, force: true })
})

const detail = (outcome: Outcome<unknown>) => (outcome.ok ? 'ok' : outcome.error.detailCode)

function count(dataDir: string, statement: string): number {
  const db = new DatabaseSync(join(dataDir, 'artifacts', 'artifacts-service.db'))
  try {
    return Number((db.prepare(statement).get() as { n: number }).n)
  } finally {
    db.close()
  }
}

const ROWS = `SELECT (SELECT COUNT(*) FROM artifacts) + (SELECT COUNT(*) FROM reservations)
  + (SELECT COUNT(*) FROM grants) + (SELECT COUNT(*) FROM requests) + (SELECT COUNT(*) FROM outbox)
  + (SELECT COUNT(*) FROM revocations) AS n`

const masked = (value: unknown, keys: ReadonlySet<string>): unknown =>
  JSON.parse(JSON.stringify(value), (key, item) => (keys.has(key) ? '*' : item))
/** A verify is recomputed on every call, and this store stamps it with the wall clock. */
const CLOCK = new Set(['checkedAt'])
/** Fence, checkpoint and export digests name one run; everything else must match a clean run. */
const RUN_IDS = new Set([...CLOCK, 'fenceId', 'checkpointId', 'exportDigest'])

const route = (
  service: Service,
  locationRef: string,
  cutoverId: string,
  checkpoint: Wire.AuthorityCheckpoint,
): Wire.AuthorityRoute => ({
  logicalAuthorityId: AUTHORITIES[service].authorityId,
  tenantId: 'tenant-1',
  authorityEpoch: 2,
  providerBinding: AUTHORITIES[service].binding,
  locationRef,
  cohortDigest: COHORT,
  cutoverId,
  checkpoint: { ...checkpoint, authorityEpoch: 2 },
  previous: { authorityEpoch: 1, locationRef: 'location-1', cutoverId: 'cutover-0' },
})

const inline = (value: Wire.AuthorityRoute) =>
  inlineData(value as unknown as JsonValue, 'agh.test/authority-route@1')

/** The orchestrator's part of a step: publish the route it needs, then build its request. */
function prepare(service: Service, step: Step, done: Done, directory: Directory): unknown {
  const fence = done.fence as Wire.AuthorityFence
  const exported = done.export as Wire.AuthorityExport
  const imported = done.import as Wire.AuthorityTransferControlImportResult
  switch (step) {
    case 'fence':
      return {
        upgradeId: UPGRADE,
        expected: { ...EXPECTED, authorityId: AUTHORITIES[service].authorityId },
        cohortDigest: COHORT,
      }
    case 'export':
      return { upgradeId: UPGRADE, fenceId: fence.fenceId }
    case 'import':
      return { upgradeId: UPGRADE, source: exported, targetLocationRef: 'location-2' }
    case 'verify':
      return { upgradeId: UPGRADE, source: exported, candidateRef: imported.candidateRef }
    case 'activate':
      // The route serving the candidate carries its checkpoint at the route's epoch.
      directory.route = route(service, 'location-2', 'cutover-1', imported.targetCheckpoint)
      return { upgradeId: UPGRADE, cutoverId: 'cutover-1', publishedRoute: inline(directory.route) }
    case 'abort':
      directory.route = route(service, 'location-1', 'recovery-1', fence.checkpoint)
      return { upgradeId: UPGRADE, expectedFenceId: fence.fenceId, recoveryRoute: inline(directory.route) }
  }
}

/** Takes the steps of one service without a kill, as a clean transfer does. */
async function take(
  world: Cohort,
  service: Service,
  steps: readonly Step[],
  done: Done,
  directory: Directory,
) {
  for (const step of steps)
    done[step] = ok(await call(sides(world, service), step, prepare(service, step, done, directory)))
}

async function observe(world: Cohort, root: string, done: Done): Promise<Seen> {
  const fenceId = (done.fence as Wire.AuthorityFence | undefined)?.fenceId ?? 'no-fence'
  const page = { upgradeId: UPGRADE, fenceId, manifestDigest: manifest, cursor: null, limit: 1 }
  const probe = ({ artifacts }: Services) => artifacts.transfer.probe({ upgradeId: UPGRADE }, MAINTAINER)
  // The reservation exists on both sides once imported, so a serving store returns it and writes nothing.
  const replay = ({ artifacts }: Services) =>
    artifacts.reserve({ request: reserveRequest('pub-live'), owner: owner() }, ctx())
  return {
    source: ok(await probe(world.source)),
    target: ok(await probe(world.target)),
    serving: { source: detail(await replay(world.source)), target: detail(await replay(world.target)) },
    exported: detail(await world.source.artifacts.transfer.exportPage(page, MAINTAINER)),
    rows: count(join(root, 'target'), ROWS),
  }
}

/** Opens the cohort in this process, looks, and closes it again. */
async function reopen<T>(
  root: string,
  directory: Directory,
  look: (world: Cohort) => Promise<T>,
): Promise<T> {
  const world = openCohort(root, directory)
  try {
    return await look(world)
  } finally {
    world.close()
  }
}

/** What a store serves of the seed: the live version's bytes, but not the withdrawn grant or revoked version. */
async function served(artifacts: ArtifactsService) {
  const { live, revoked } = seeded
  const read = await artifacts.artifactAccess.readRange({ ...live, offset: 0, length: MIB }, ctx())
  return {
    live: ok(await artifacts.artifactAccess.describe(live, ctx())),
    digest: ok(read).digest,
    withdrawn: detail(await artifacts.artifactAccess.describe(live, ctx({ principalRef: 'user-2' }))),
    revoked: detail(await artifacts.artifactAccess.readRange({ ...revoked, offset: 0, length: 1 }, ctx())),
    events: artifacts.pendingEvents(),
  }
}

async function copy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agh-artifacts-transfer-'))
  scratch.push(root)
  for (const side of ['source', 'target']) cpSync(join(template, side), join(root, side), { recursive: true })
  return root
}

/**
 * A ready version user-1 reads while user-2's grant to it was revoked, a revoked version user-1
 * holds a grant to, and a reservation never published; the outbox keeps three pending events.
 */
async function populate({ artifacts, blob }: Services) {
  const publish = async (publicationId: string, salt: number) => {
    const reserved = ok(
      await artifacts.reserve({ request: reserveRequest(publicationId), owner: owner() }, ctx()),
    )
    const sealed = await upload(blob, {
      uploadId: `upload-${publicationId}`,
      bytes: BYTES,
      salt,
      mediaType: 'text/plain',
      chunkBytes: MIB,
      digest: null,
    })
    ok(await artifacts.publish({ request: publishRequest(publicationId, sealed), owner: owner() }, ctx()))
    return { artifactId: reserved.artifactId, version: reserved.version }
  }
  const grant = async (artifactRef: Wire.ArtifactRef, requestId: string, granteePrincipalRef: string) =>
    ok(
      await artifacts.grant(
        {
          request: {
            requestId,
            artifactRef,
            granteePrincipalRef,
            scope: SCOPE,
            permissions: ['read', 'download'],
            expiresAt: null,
          },
          owner: owner(),
          sourceAuthorizationRef: 'policy-1',
        },
        ctx(),
      ),
    )
  const live = await publish('pub-live', 1)
  await grant(live, 'grant-live', 'user-1')
  const { grantId } = await grant(live, 'grant-withdrawn', 'user-2')
  const request = { requestId: 'revoke-1', grantId, expectedRevision: 1, reason: 'done' }
  ok(await artifacts.revokeGrant({ request, owner: owner() }, ctx()))
  const revoked = await publish('pub-revoked', 2)
  await grant(revoked, 'grant-revoked', 'user-1')
  ok(await artifacts.revoke({ artifactRef: revoked, reason: 'withdrawn' }, ctx()))
  ok(await artifacts.reserve({ request: reserveRequest('pub-held'), owner: owner() }, ctx()))
  return { live, revoked }
}

/** Runs the artifacts steps without a kill and lists the export manifest. */
async function run(steps: readonly Step[]) {
  const root = await copy()
  const directory: Directory = {}
  const done: Done = {}
  const world = openCohort(root, directory)
  try {
    await take(world, 'artifacts', steps, done, directory)
    manifest ||= indexDigest((done.export as Wire.AuthorityExport).manifestRoot)
    const items: Wire.AuthorityExportPart[] = []
    const fenceId = (done.fence as Wire.AuthorityFence).fenceId
    for (let cursor: string | null = null; ; ) {
      const page: Wire.AuthorityTransferControlExportPageResult = ok(
        await world.source.artifacts.transfer.exportPage(
          { upgradeId: UPGRADE, fenceId, manifestDigest: manifest, cursor, limit: 100 },
          MAINTAINER,
        ),
      )
      items.push(...page.items)
      if (page.complete) break
      cursor = page.nextCursor
    }
    const serving = steps.includes('abort') ? world.source : world.target
    return {
      done,
      final: await observe(world, root, done),
      served: await served(serving.artifacts),
      parts: items,
    }
  } finally {
    world.close()
  }
}

beforeAll(async () => {
  template = await mkdtemp(join(tmpdir(), 'agh-artifacts-transfer-template-'))
  const world = openCohort(template, {})
  try {
    seeded = await populate(world.source)
    original = await served(world.source.artifacts)
    await take(world, 'blob', BLOB_FIRST, {}, {})
  } finally {
    world.close()
  }
  const transfer = await run(TRANSFER)
  parts = transfer.parts
  clean = { transfer, abort: await run(ABORTED) }
}, 60_000)

describe('artifacts authority transfer killed inside a provider step', () => {
  it('reaches the end states each kill must converge to when nothing is killed', () => {
    const { done, final } = clean.transfer
    const fence = done.fence as Wire.AuthorityFence
    const exported = done.export as Wire.AuthorityExport
    const { recordCount } = fence.checkpoint
    expect(final).toEqual({
      source: { state: 'fenced', fence },
      target: done.activate,
      serving: { source: 'blocked', target: 'ok' },
      exported: 'ok',
      rows: recordCount,
    })
    // Both published versions name content, and the target's blob store holds it intact.
    const validation = done.verify as Wire.MigrationValidation
    expect(validation.accepted).toBe(true)
    expect(validation.checks.find(({ checkId }) => checkId === 'required-assets')?.evidence).toMatchObject({
      value: { expected: 2, actual: 2 },
    })
    // Each business table is one part, so a kill after some parts falls between two tables.
    expect(parts.length).toBe(exported.partCount)
    expect(exported.collectionCount).toBe(parts.length)
    expect(parts.length).toBeGreaterThan(PARTS_KEPT + 1)
    expect(original).toMatchObject({
      live: { status: 'ready', size: BYTES },
      digest: patternDigest(0, BYTES, 1),
      withdrawn: 'permission_denied',
      revoked: 'revoked',
    })
    expect(original.events.map(({ eventKey }) => eventKey)).toEqual([
      'pub-live:ready',
      'pub-revoked:ready',
      'pub-revoked:revoked',
    ])
    expect(clean.transfer.served).toEqual(original)
    expect(clean.abort.final).toMatchObject({
      source: { state: 'aborted', source: EXPECTED, restoredEpoch: 2 },
      target: { state: 'imported' },
      serving: { source: 'ok', target: 'blocked' },
      rows: recordCount,
    })
    expect(clean.abort.served).toEqual(original)
  })

  it.each(POINTS)(
    'converges after a kill at $point',
    async ({ point, step, committed, imported }) => {
      const steps = step === 'abort' ? ABORTED : TRANSFER
      const at = steps.indexOf(step)
      const root = await copy()
      const directory: Directory = {}
      const done: Done = {}
      let world = openCohort(root, directory)
      let pre: Seen
      let request: unknown
      try {
        await take(world, 'artifacts', steps.slice(0, at), done, directory)
        request = prepare('artifacts', step, done, directory)
        pre = await observe(world, root, done)
      } finally {
        world.close()
      }

      const child = startChild('./blob-transfer-child.ts', [
        root,
        step,
        point,
        JSON.stringify(request),
        JSON.stringify(directory),
        'artifacts',
      ])
      children.push(child)
      await child.until('paused', point)
      await child.kill()

      // Fresh processes see the durable truth, and the same truth again on a second open.
      const look = (cohort: Cohort) => observe(cohort, root, done)
      const killed = await reopen(root, directory, look)
      expect(await reopen(root, directory, look)).toEqual(killed)
      // Before the step's commit, the stores hold what they held before it, plus the import's rows.
      const rows = {
        none: 0,
        parts: parts.slice(0, PARTS_KEPT).reduce((sum, part) => sum + part.records, 0),
        all: (clean.transfer.done.fence as Wire.AuthorityFence).checkpoint.recordCount,
      }
      if (!committed) expect(killed).toEqual(imported ? { ...pre, rows: rows[imported] } : pre)

      // The same request again, then the rest of the transfer.
      world = openCohort(root, directory)
      let after: Seen
      let final: Seen
      try {
        done[step] = ok(await call(sides(world, 'artifacts'), step, request))
        const again = ok(await call(sides(world, 'artifacts'), step, request))
        expect(masked(again, CLOCK)).toEqual(masked(done[step], CLOCK))
        after = await observe(world, root, done)
        await take(world, 'artifacts', steps.slice(at + 1), done, directory)
        final = await observe(world, root, done)
      } finally {
        world.close()
      }
      expect(await reopen(root, directory, look)).toEqual(final)
      // After the step's commit, the kill already left what the retry returns.
      if (committed) expect(killed).toEqual(after)

      // At most one side serves business writes at any moment.
      for (const seen of [pre, killed, after, final])
        expect(Object.values(seen.serving).filter((code) => code === 'ok').length).toBeLessThanOrEqual(1)
      const baseline = clean[step === 'abort' ? 'abort' : 'transfer']
      expect(masked(done, RUN_IDS)).toEqual(masked(baseline.done, RUN_IDS))
      expect(masked(final, RUN_IDS)).toEqual(masked(baseline.final, RUN_IDS))
      // The side left serving serves the seed as the source served it before the transfer.
      const side = step === 'abort' ? 'source' : 'target'
      expect(await reopen(root, directory, (cohort) => served(cohort[side].artifacts))).toEqual(original)
    },
    30_000,
  )
})
