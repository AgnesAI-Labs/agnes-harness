import { cpSync, existsSync } from 'node:fs'
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
import { type BlobService, createBlobService } from '../../src/runtime/providers/blob.js'
import {
  BLOB_BINDING,
  type Child,
  ctx,
  MIB,
  ok,
  pattern,
  SCOPE,
  startChild,
} from './fixtures/artifact-world.js'
import {
  call,
  type Directory,
  MAINTAINER,
  openWorld,
  PARTS_KEPT,
  START,
  type Step,
  UPGRADE,
  type World,
} from './fixtures/blob-transfer-world.js'

const EXPECTED = { authorityId: 'blob-authority', tenantId: 'tenant-1', authorityEpoch: 1 }
const FENCE = { upgradeId: UPGRADE, expected: EXPECTED, cohortDigest: 'c'.repeat(64) }
/** An upload still receiving bytes. Staging it again is a business write that changes no row. */
const OPEN = { uploadId: 'upload-open', size: 4 * MIB, mediaType: 'text/plain', expectedDigest: null }
const TRANSFER: readonly Step[] = ['fence', 'export', 'import', 'verify', 'activate']
const ABORTED: readonly Step[] = ['fence', 'export', 'import', 'abort']

type Done = Partial<Record<Step, unknown>>

/** What a process opening both stores can see. */
type Seen = {
  source: Wire.AuthorityTransferProbe
  target: Wire.AuthorityTransferProbe
  /** A business write on each side: `ok` while it serves, the refusal otherwise. */
  serving: Record<'source' | 'target', string>
  /** A page of the source's export manifest, or the refusal. */
  exported: string
  /** Business rows the target holds. */
  rows: number
  /** Content files of the source's required assets on the target. */
  assets: number
  /** Whether content collected before the fence exists again on either side. */
  resurrected: boolean
}

/**
 * Each point is where the step's process is killed. A point after the step's commit must already
 * show what a retry of the step shows; any other point must show what the stores held before the
 * step, except for the import's progress on the target.
 */
const POINTS: {
  point: string
  step: Step
  committed: boolean
  imported?: { rows: 'none' | 'parts' | 'all'; assets: number }
}[] = [
  { point: 'fence-open', step: 'fence', committed: false },
  { point: 'fence-committed', step: 'fence', committed: true },
  { point: 'export-partial', step: 'export', committed: false },
  { point: 'export-recorded', step: 'export', committed: true },
  { point: 'import-asset', step: 'import', committed: false, imported: { rows: 'none', assets: 1 } },
  { point: 'import-part-rows', step: 'import', committed: false, imported: { rows: 'parts', assets: 3 } },
  {
    point: 'import-part-checkpoint',
    step: 'import',
    committed: false,
    imported: { rows: 'parts', assets: 3 },
  },
  {
    point: 'import-part-committed',
    step: 'import',
    committed: false,
    imported: { rows: 'parts', assets: 3 },
  },
  { point: 'import-walked', step: 'import', committed: false, imported: { rows: 'all', assets: 3 } },
  { point: 'activate-open', step: 'activate', committed: false },
  { point: 'activate-committed', step: 'activate', committed: true },
  { point: 'abort-open', step: 'abort', committed: false },
  { point: 'abort-committed', step: 'abort', committed: true },
]

const scratch: string[] = []
const children: Child[] = []
let template = ''
let content = { assets: [] as string[], collected: '' }
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

const contentFile = (dataDir: string, digest: string) =>
  join(dataDir, 'artifacts', 'sha256', digest.slice(0, 2), digest)

function count(dataDir: string, statement: string): number {
  const db = new DatabaseSync(join(dataDir, 'artifacts', 'blob-service.db'))
  try {
    return Number((db.prepare(statement).get() as { n: number }).n)
  } finally {
    db.close()
  }
}

const ROWS = `SELECT (SELECT COUNT(*) FROM uploads) + (SELECT COUNT(*) FROM upload_chunks)
  + (SELECT COUNT(*) FROM blobs) + (SELECT COUNT(*) FROM roots) + (SELECT COUNT(*) FROM deletions) AS n`

/** Fence, checkpoint and export digests name one run; everything else must match a clean run. */
const RUN_IDS = new Set(['fenceId', 'checkpointId', 'exportDigest'])
const normalized = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (key, item) => (RUN_IDS.has(key) ? '*' : item))

const route = (
  locationRef: string,
  cutoverId: string,
  checkpoint: Wire.AuthorityCheckpoint,
): Wire.AuthorityRoute => ({
  logicalAuthorityId: 'blob-authority',
  tenantId: 'tenant-1',
  authorityEpoch: 2,
  providerBinding: BLOB_BINDING,
  locationRef,
  cohortDigest: 'c'.repeat(64),
  cutoverId,
  checkpoint: { ...checkpoint, authorityEpoch: 2 },
  previous: { authorityEpoch: 1, locationRef: 'location-1', cutoverId: 'cutover-0' },
})

const inline = (value: Wire.AuthorityRoute) =>
  inlineData(value as unknown as JsonValue, 'agh.test/authority-route@1')

/** The orchestrator's part of a step: publish the route it needs, then build its request. */
function prepare(step: Step, done: Done, directory: Directory): unknown {
  const fence = done.fence as Wire.AuthorityFence
  const exported = done.export as Wire.AuthorityExport
  const imported = done.import as Wire.AuthorityTransferControlImportResult
  switch (step) {
    case 'fence':
      return FENCE
    case 'export':
      return { upgradeId: UPGRADE, fenceId: fence.fenceId }
    case 'import':
      return { upgradeId: UPGRADE, source: exported, targetLocationRef: 'location-2' }
    case 'verify':
      return { upgradeId: UPGRADE, source: exported, candidateRef: imported.candidateRef }
    case 'activate':
      // The route serving the candidate carries its checkpoint at the route's epoch.
      directory.route = route('location-2', 'cutover-1', imported.targetCheckpoint)
      return { upgradeId: UPGRADE, cutoverId: 'cutover-1', publishedRoute: inline(directory.route) }
    case 'abort':
      directory.route = route('location-1', 'recovery-1', fence.checkpoint)
      return { upgradeId: UPGRADE, expectedFenceId: fence.fenceId, recoveryRoute: inline(directory.route) }
  }
}

async function observe(world: World, root: string, done: Done): Promise<Seen> {
  const target = join(root, 'target')
  const fenceId = (done.fence as Wire.AuthorityFence | undefined)?.fenceId ?? 'no-fence'
  const page = { upgradeId: UPGRADE, fenceId, manifestDigest: manifest, cursor: null, limit: 1 }
  const probe = (blob: BlobService) => blob.transfer.probe({ upgradeId: UPGRADE }, MAINTAINER)
  return {
    source: ok(await probe(world.source)),
    target: ok(await probe(world.target)),
    serving: {
      source: detail(await world.source.stage(OPEN, ctx())),
      target: detail(await world.target.stage(OPEN, ctx())),
    },
    exported: detail(await world.source.transfer.exportPage(page, MAINTAINER)),
    rows: count(target, ROWS),
    assets: content.assets.filter((digest) => existsSync(contentFile(target, digest))).length,
    resurrected: ['source', 'target'].some((side) =>
      existsSync(contentFile(join(root, side), content.collected)),
    ),
  }
}

/** Opens both stores in this process, looks, and closes them again. */
async function reopen(root: string, directory: Directory, done: Done): Promise<Seen> {
  const world = openWorld(root, directory)
  try {
    return await observe(world, root, done)
  } finally {
    world.close()
  }
}

async function copy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agh-blob-transfer-'))
  scratch.push(root)
  cpSync(template, join(root, 'source'), { recursive: true })
  return root
}

async function sealed(blob: BlobService, uploadId: string, text: string): Promise<Wire.UploadResult> {
  const bytes = new TextEncoder().encode(text)
  ok(
    await blob.stage(
      { uploadId, size: bytes.byteLength, mediaType: 'text/plain', expectedDigest: null },
      ctx(),
    ),
  )
  const writer = ok(blob.openWriter(uploadId, ctx()))
  try {
    ok(writer.write(0, bytes))
    return ok(await writer.seal())
  } finally {
    writer.close()
  }
}

/**
 * A source holding every kind of row and content its store keeps: a pin, a staged blob, a sealed
 * upload, content collected before the fence, and an open upload whose chunks span two export parts.
 */
async function populate(dataDir: string) {
  const blob = createBlobService({
    dataDir,
    authorityId: 'blob-authority',
    binding: BLOB_BINDING,
    now: () => START,
  })
  try {
    const promote = async ({ upload }: Wire.UploadResult) =>
      ok(await blob.promote({ upload, expectedDigest: upload.digest }, ctx()))
    const kept = await sealed(blob, 'upload-kept', 'kept bytes')
    const ownerRef: Wire.PublicRef = { kind: 'artifact', value: { artifactId: 'artifact-1', version: 1 } }
    ok(await blob.pin({ stagedBlob: await promote(kept), ownerRef, retentionUntil: null }, ctx()))
    const loose = await sealed(blob, 'upload-loose', 'staged, never pinned')
    await promote(loose)
    const held = await sealed(blob, 'upload-sealed', 'sealed, never promoted')
    const gone = await sealed(blob, 'upload-gone', 'collected')
    await promote(gone)
    ok(await blob.unpin({ pinId: gone.retention.pinId, expectedRevision: 1 }, ctx()))
    ok(await blob.gc({ scopeRef: SCOPE, dryRun: false, cursor: null, limit: 100 }, ctx()))
    ok(await blob.stage(OPEN, ctx()))
    const writer = ok(blob.openWriter(OPEN.uploadId, ctx()))
    for (let at = 0; at < 3 * MIB; at += MIB) ok(writer.write(at, pattern(at, MIB)))
    writer.close()
    return { assets: [kept, loose, held].map(({ upload }) => upload.digest), collected: gone.upload.digest }
  } finally {
    blob.close()
  }
}

/** Runs the steps without a kill, as a clean transfer does, and lists the export manifest. */
async function run(steps: readonly Step[]) {
  const root = await copy()
  const directory: Directory = {}
  const done: Done = {}
  const world = openWorld(root, directory)
  try {
    for (const step of steps) done[step] = ok(await call(world, step, prepare(step, done, directory)))
    manifest ||= indexDigest((done.export as Wire.AuthorityExport).manifestRoot)
    const items: Wire.AuthorityExportPart[] = []
    const fenceId = (done.fence as Wire.AuthorityFence).fenceId
    for (let cursor: string | null = null; ; ) {
      const page: Wire.AuthorityTransferControlExportPageResult = ok(
        await world.source.transfer.exportPage(
          { upgradeId: UPGRADE, fenceId, manifestDigest: manifest, cursor, limit: 100 },
          MAINTAINER,
        ),
      )
      items.push(...page.items)
      if (page.complete) break
      cursor = page.nextCursor
    }
    return { done, final: await observe(world, root, done), root, parts: items }
  } finally {
    world.close()
  }
}

beforeAll(async () => {
  template = await mkdtemp(join(tmpdir(), 'agh-blob-transfer-template-'))
  content = await populate(template)
  const transfer = await run(TRANSFER)
  parts = transfer.parts
  clean = { transfer, abort: await run(ABORTED) }
}, 60_000)

describe('blob authority transfer killed inside a provider step', () => {
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
      assets: content.assets.length,
      resurrected: false,
    })
    expect((done.verify as Wire.MigrationValidation).accepted).toBe(true)
    expect(count(join(clean.transfer.root, 'target'), 'SELECT MAX(seq) AS n FROM deletions')).toBe(
      exported.deletionWatermark,
    )
    // The chunk table spans several parts, so a kill after some of them falls inside one table.
    expect(parts.length).toBe(exported.partCount)
    expect(parts.length).toBeGreaterThan(PARTS_KEPT + 1)
    expect(parts.filter(({ collectionId }) => collectionId === 'blob.upload_chunks').length).toBeGreaterThan(
      1,
    )
    expect(parts.slice(0, PARTS_KEPT + 1).at(-1)?.collectionId).toBe('blob.upload_chunks')
    expect(clean.abort.final).toMatchObject({
      source: { state: 'aborted', source: EXPECTED, restoredEpoch: 2 },
      target: { state: 'imported' },
      serving: { source: 'ok', target: 'blocked' },
      rows: recordCount,
      resurrected: false,
    })
  })

  it.each(POINTS)(
    'converges after a kill at $point',
    async ({ point, step, committed, imported }) => {
      const steps = step === 'abort' ? ABORTED : TRANSFER
      const at = steps.indexOf(step)
      const root = await copy()
      const directory: Directory = {}
      const done: Done = {}
      let world = openWorld(root, directory)
      let pre: Seen
      let request: unknown
      try {
        for (const prior of steps.slice(0, at))
          done[prior] = ok(await call(world, prior, prepare(prior, done, directory)))
        request = prepare(step, done, directory)
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
      ])
      children.push(child)
      await child.until('paused', point)
      await child.kill()

      // Fresh processes see the durable truth, and the same truth again on a second open.
      const killed = await reopen(root, directory, done)
      expect(await reopen(root, directory, done)).toEqual(killed)
      // Before the step's commit, the stores hold what they held before it, plus the import's progress.
      const rows = {
        none: 0,
        parts: parts.slice(0, PARTS_KEPT).reduce((sum, part) => sum + part.records, 0),
        all: (clean.transfer.done.fence as Wire.AuthorityFence).checkpoint.recordCount,
      }
      const progress = imported ? { rows: rows[imported.rows], assets: imported.assets } : {}
      if (!committed) expect(killed).toEqual({ ...pre, ...progress })

      // The same request again, then the rest of the transfer.
      world = openWorld(root, directory)
      let after: Seen
      let final: Seen
      try {
        done[step] = ok(await call(world, step, request))
        expect(ok(await call(world, step, request))).toEqual(done[step])
        after = await observe(world, root, done)
        for (const next of steps.slice(at + 1))
          done[next] = ok(await call(world, next, prepare(next, done, directory)))
        final = await observe(world, root, done)
      } finally {
        world.close()
      }
      expect(await reopen(root, directory, done)).toEqual(final)
      // After the step's commit, the kill already left what the retry returns.
      if (committed) expect(killed).toEqual(after)

      // At most one side serves business writes at any moment.
      for (const seen of [pre, killed, after, final])
        expect(Object.values(seen.serving).filter((code) => code === 'ok').length).toBeLessThanOrEqual(1)
      const baseline = clean[step === 'abort' ? 'abort' : 'transfer']
      expect(normalized(done)).toEqual(normalized(baseline.done))
      expect(normalized(final)).toEqual(normalized(baseline.final))
      if (step !== 'abort')
        expect(count(join(root, 'target'), 'SELECT MAX(seq) AS n FROM deletions')).toBe(
          (done.export as Wire.AuthorityExport).deletionWatermark,
        )
    },
    30_000,
  )
})
