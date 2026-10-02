import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonDigest, type JsonValue } from '@agnes/protocol/runtime'

export const configReferenceProvider = {
  id: 'reference',
  contract: 'agh.config',
} as const

const CONTRACT = 'agh.config'
const PACKAGE_NAME = '@agnes-examples/runtime-reference'
const PROVIDER_ID = 'reference'

export interface ReferenceConfigEvidence {
  readonly passed: boolean
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly detail: string
}

export interface ReferenceConfigPort {
  readonly recipe: 'file' | 'fetch'
  select(): Promise<ReferenceConfigEvidence>
  normal(): Promise<ReferenceConfigEvidence>
  deny(): Promise<ReferenceConfigEvidence>
  cancel(): Promise<ReferenceConfigEvidence>
  recover(): Promise<ReferenceConfigEvidence>
  dispose(): Promise<ReferenceConfigEvidence>
}

type Recipe = ReferenceConfigPort['recipe']
type Refusal = { readonly code: string }
type Outcome<T> = { ok: true; result: T } | { ok: false; refusal: Refusal }
type ReadResult = { readonly digest: string; readonly revision: number }
type ResolveResult = {
  readonly status: 'candidate'
  readonly profileDigest: string
  readonly presetDigest: string
  readonly sourceSetDigest: string
}
type Document = Record<string, unknown>
type BoundDocument = { readonly document: Document }
type ResolveRequest = {
  readonly defaults: { readonly profile: BoundDocument; readonly preset: BoundDocument }
  readonly profiles: readonly BoundDocument[]
  readonly presets: readonly BoundDocument[]
}
type Snapshot = { readonly revision: number; readonly value: unknown }

interface ReferenceProvider {
  readonly providerId: typeof PROVIDER_ID
  readonly contract: typeof CONTRACT
  readonly packageName: typeof PACKAGE_NAME
  read(input: { readonly sourceRef: string; readonly revision: number | null }): Outcome<ReadResult>
  resolve(input: ResolveRequest): Outcome<ResolveResult>
  dispose(): void
  readonly disposed: boolean
}

interface Memory {
  readonly revisions: Map<string, Map<number, string>>
  readonly latest: Map<string, number>
  disposed: boolean
}

interface Opened<TRefresh> {
  readonly provider: ReferenceProvider
  readonly refresh: TRefresh
  readonly loads: () => number
}

type FileRefresh = (sourceRef: string, signal?: AbortSignal) => Refusal | null

function documentDigest(value: unknown): string {
  return canonicalJsonDigest(JSON.parse(JSON.stringify(value)) as JsonValue)
}

function refusal(code: string): Refusal {
  return { code }
}

function failed(code: string): Outcome<never> {
  return { ok: false, refusal: refusal(code) }
}

function packagesOf(document: Document): Map<string, boolean> {
  const rows = document.packages
  const found = new Map<string, boolean>()
  if (!Array.isArray(rows)) return found
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as { id?: unknown; enabled?: unknown }
    if (typeof record.id === 'string' && typeof record.enabled === 'boolean') {
      found.set(record.id, record.enabled)
    }
  }
  return found
}

function revivesDisabledPackage(parent: Document, child: Document): boolean {
  const disabled = packagesOf(parent)
  for (const [id, enabled] of packagesOf(child)) {
    if (enabled && disabled.get(id) === false) return true
  }
  return false
}

function createProvider(memory: Memory): ReferenceProvider {
  return {
    providerId: PROVIDER_ID,
    contract: CONTRACT,
    packageName: PACKAGE_NAME,
    get disposed() {
      return memory.disposed
    },
    read(input) {
      if (memory.disposed) return failed('disposed')
      const byRevision = memory.revisions.get(input.sourceRef)
      const current = memory.latest.get(input.sourceRef)
      if (byRevision === undefined || current === undefined) return failed('source_unavailable')
      const revision = input.revision === null ? current : input.revision
      const digest = byRevision.get(revision)
      if (digest === undefined) return failed('source_unavailable')
      return { ok: true, result: { digest, revision } }
    },
    resolve(input) {
      if (memory.disposed) return failed('disposed')
      const child = input.profiles[0]?.document ?? input.defaults.profile.document
      const preset = input.presets[0]?.document ?? input.defaults.preset.document
      if (revivesDisabledPackage(input.defaults.profile.document, child)) {
        return failed('disabled_package_revived')
      }
      return {
        ok: true,
        result: {
          status: 'candidate',
          profileDigest: documentDigest(child),
          presetDigest: documentDigest(preset),
          sourceSetDigest: documentDigest({
            profiles: [input.defaults.profile.document.id, child.id],
            presets: [input.defaults.preset.document.id, preset.id],
          }),
        },
      }
    },
    dispose() {
      memory.disposed = true
    },
  }
}

function admit(memory: Memory, sourceRef: string, body: Snapshot): Refusal | null {
  if (memory.disposed) return refusal('disposed')
  if (!Number.isSafeInteger(body.revision) || body.revision < 1) return refusal('schema_invalid')
  const digest = documentDigest(body.value)
  const byRevision = memory.revisions.get(sourceRef) ?? new Map<number, string>()
  const existing = byRevision.get(body.revision)
  if (existing !== undefined && existing !== digest) return refusal('revision_conflict')
  if (existing === undefined) {
    byRevision.set(body.revision, digest)
    memory.revisions.set(sourceRef, byRevision)
    const current = memory.latest.get(sourceRef)
    memory.latest.set(sourceRef, current === undefined ? body.revision : Math.max(current, body.revision))
  }
  return null
}

function snapshotFrom(value: unknown): Snapshot | Refusal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refusal('schema_invalid')
  const record = value as { revision?: unknown; value?: unknown }
  if (typeof record.revision !== 'number') return refusal('schema_invalid')
  return { revision: record.revision, value: record.value }
}

function openFile(load: (sourceRef: string) => string | null): Opened<FileRefresh> {
  const memory: Memory = { revisions: new Map(), latest: new Map(), disposed: false }
  let loads = 0
  const provider = createProvider(memory)
  return {
    provider,
    loads: () => loads,
    refresh(sourceRef, signal) {
      if (memory.disposed) return refusal('disposed')
      if (signal?.aborted) return refusal('cancelled')
      loads += 1
      const text = load(sourceRef)
      if (signal?.aborted) return refusal('cancelled')
      if (text === null) return refusal('source_unavailable')
      let parsed: unknown
      try {
        parsed = JSON.parse(text) as unknown
      } catch {
        return refusal('schema_invalid')
      }
      const body = snapshotFrom(parsed)
      if ('code' in body) return body
      return admit(memory, sourceRef, body)
    },
  }
}

function openFetch(
  fetchSnapshot: (sourceRef: string, signal: AbortSignal) => Promise<unknown>,
): Opened<(sourceRef: string, signal?: AbortSignal) => Promise<Refusal | null>> {
  const memory: Memory = { revisions: new Map(), latest: new Map(), disposed: false }
  let loads = 0
  const provider = createProvider(memory)
  return {
    provider,
    loads: () => loads,
    async refresh(sourceRef, signal) {
      if (memory.disposed) return refusal('disposed')
      if (signal?.aborted) return refusal('cancelled')
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      try {
        loads += 1
        const fetched = await fetchSnapshot(sourceRef, controller.signal)
        if (signal?.aborted || controller.signal.aborted) return refusal('cancelled')
        const body = snapshotFrom(fetched)
        if ('code' in body) return body
        return admit(memory, sourceRef, body)
      } catch {
        if (signal?.aborted || controller.signal.aborted) return refusal('cancelled')
        return refusal('source_unavailable')
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },
  }
}

function providerDigest(recipe: Recipe): string {
  return documentDigest({ providerId: PROVIDER_ID, contract: CONTRACT, packageName: PACKAGE_NAME, recipe })
}

function evidence(
  recipe: Recipe,
  configDigest: string,
  releaseSetDigest: string,
  detail: string,
): ReferenceConfigEvidence {
  return { passed: true, providerDigest: providerDigest(recipe), configDigest, releaseSetDigest, detail }
}

function profile(id: string): Document {
  return { id, packages: [] }
}

function preset(id: string, name: string): Document {
  return { id, parameters: { name } }
}

function chain(mutate?: (documents: { parent: Document; child: Document }) => void): ResolveRequest {
  const parent = profile('builtin')
  const child = profile('deployed')
  child.extends = { profileId: 'builtin' }
  mutate?.({ parent, child })
  return {
    defaults: { profile: { document: parent }, preset: { document: preset('base', 'base') } },
    profiles: [{ document: child }],
    presets: [{ document: preset('leaf', 'leaf') }],
  }
}

function snapshot(revision: number, name: string): Snapshot {
  return { revision, value: { name } }
}

function packageRow(id: string, enabled: boolean): { id: string; enabled: boolean } {
  return { id, enabled }
}

async function select(recipe: Recipe): Promise<ReferenceConfigEvidence> {
  const opened =
    recipe === 'file'
      ? openFile(() => null)
      : openFetch(async () => {
          throw new Error('select must not fetch')
        })
  try {
    assert.equal(opened.provider.providerId, PROVIDER_ID)
    assert.equal(opened.provider.contract, CONTRACT)
    assert.equal(opened.provider.packageName, PACKAGE_NAME)
    assert.equal(opened.loads(), 0)
    const digest = providerDigest(recipe)
    return evidence(recipe, digest, documentDigest({ selected: recipe }), PROVIDER_ID)
  } finally {
    opened.provider.dispose()
  }
}

async function normal(recipe: Recipe): Promise<ReferenceConfigEvidence> {
  const body = snapshot(1, 'pinned')
  const opened = recipe === 'file' ? openFile(() => JSON.stringify(body)) : openFetch(async () => body)
  const sibling =
    recipe === 'file'
      ? openFetch(async () => {
          throw new Error('resolve must not fetch')
        })
      : openFile(() => {
          throw new Error('resolve must not load')
        })
  try {
    assert.equal(await opened.refresh('local'), null)
    const afterAdmit = opened.loads()
    const pinned = opened.provider.read({ sourceRef: 'local', revision: 1 })
    assert.equal(pinned.ok, true)
    if (!pinned.ok) return evidence(recipe, providerDigest(recipe), providerDigest(recipe), 'unread')
    assert.equal(opened.loads(), afterAdmit)
    assert.equal(pinned.result.digest, documentDigest(body.value))
    const request = chain()
    const resolved = opened.provider.resolve(request)
    const other = sibling.provider.resolve(request)
    assert.equal(opened.loads(), afterAdmit)
    assert.equal(sibling.loads(), 0)
    assert.equal(resolved.ok && other.ok, true)
    if (!resolved.ok || !other.ok) {
      return evidence(recipe, pinned.result.digest, pinned.result.digest, 'unresolved')
    }
    assert.equal(resolved.result.status, 'candidate')
    assert.equal(other.result.profileDigest, resolved.result.profileDigest)
    assert.equal(other.result.presetDigest, resolved.result.presetDigest)
    assert.equal(other.result.sourceSetDigest, resolved.result.sourceSetDigest)
    return evidence(
      recipe,
      resolved.result.profileDigest,
      resolved.result.sourceSetDigest,
      pinned.result.digest,
    )
  } finally {
    opened.provider.dispose()
    sibling.provider.dispose()
  }
}

async function deny(recipe: Recipe): Promise<ReferenceConfigEvidence> {
  const opened =
    recipe === 'file'
      ? openFile(() => null)
      : openFetch(async () => {
          throw new Error('deny must not fetch')
        })
  try {
    const resolved = opened.provider.resolve(
      chain(({ parent, child }) => {
        parent.packages = [packageRow('tools', false)]
        child.packages = [packageRow('tools', true)]
      }),
    )
    assert.equal(resolved.ok, false)
    if (resolved.ok) return evidence(recipe, providerDigest(recipe), providerDigest(recipe), 'not refused')
    assert.equal(resolved.refusal.code, 'disabled_package_revived')
    assert.equal(opened.loads(), 0)
    const digest = documentDigest({ code: resolved.refusal.code })
    return evidence(
      recipe,
      digest,
      documentDigest({ recipe, refused: resolved.refusal.code }),
      resolved.refusal.code,
    )
  } finally {
    opened.provider.dispose()
  }
}

async function cancel(recipe: Recipe): Promise<ReferenceConfigEvidence> {
  if (recipe === 'file') {
    const opened = openFile(() => JSON.stringify(snapshot(1, 'pinned')))
    try {
      const controller = new AbortController()
      controller.abort()
      assert.equal(opened.refresh('local', controller.signal)?.code, 'cancelled')
      assert.equal(opened.loads(), 0)
      const read = opened.provider.read({ sourceRef: 'local', revision: null })
      assert.equal(read.ok, false)
      const digest = documentDigest({ code: 'cancelled', recipe })
      return evidence(recipe, digest, digest, 'cancelled')
    } finally {
      opened.provider.dispose()
    }
  }
  const opened = openFetch(
    (_sourceRef, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
  )
  try {
    const controller = new AbortController()
    const pending = opened.refresh('remote', controller.signal)
    controller.abort()
    assert.equal((await pending)?.code, 'cancelled')
    const read = opened.provider.read({ sourceRef: 'remote', revision: null })
    assert.equal(read.ok, false)
    const digest = documentDigest({ code: 'cancelled', recipe })
    return evidence(recipe, digest, digest, 'cancelled')
  } finally {
    opened.provider.dispose()
  }
}

async function recover(recipe: Recipe): Promise<ReferenceConfigEvidence> {
  const body = snapshot(1, 'pinned')
  if (recipe === 'file') {
    const directory = mkdtempSync(join(tmpdir(), 'reference-config-recover-'))
    const path = join(directory, 'local.json')
    try {
      writeFileSync(path, JSON.stringify(body))
      const load = () => readFileSync(path, 'utf8')
      const first = openFile(load)
      assert.equal(first.refresh('local'), null)
      const pinned = first.provider.read({ sourceRef: 'local', revision: 1 })
      first.provider.dispose()
      assert.equal(pinned.ok, true)
      if (!pinned.ok) return evidence(recipe, providerDigest(recipe), providerDigest(recipe), 'unread')
      const second = openFile(load)
      try {
        assert.equal(second.refresh('local'), null)
        const restored = second.provider.read({ sourceRef: 'local', revision: 1 })
        assert.equal(restored.ok, true)
        if (!restored.ok) return evidence(recipe, pinned.result.digest, pinned.result.digest, 'unrestored')
        assert.equal(restored.result.digest, pinned.result.digest)
        assert.equal(restored.result.digest, documentDigest(body.value))
        return evidence(recipe, restored.result.digest, restored.result.digest, 'recovered')
      } finally {
        second.provider.dispose()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  const fetchBody = async () => body
  const first = openFetch(fetchBody)
  assert.equal(await first.refresh('remote'), null)
  const pinned = first.provider.read({ sourceRef: 'remote', revision: 1 })
  first.provider.dispose()
  assert.equal(pinned.ok, true)
  if (!pinned.ok) return evidence(recipe, providerDigest(recipe), providerDigest(recipe), 'unread')
  const second = openFetch(fetchBody)
  try {
    assert.equal(await second.refresh('remote'), null)
    const restored = second.provider.read({ sourceRef: 'remote', revision: 1 })
    assert.equal(restored.ok, true)
    if (!restored.ok) return evidence(recipe, pinned.result.digest, pinned.result.digest, 'unrestored')
    assert.equal(restored.result.digest, pinned.result.digest)
    return evidence(recipe, restored.result.digest, restored.result.digest, 'recovered')
  } finally {
    second.provider.dispose()
  }
}

async function dispose(recipe: Recipe): Promise<ReferenceConfigEvidence> {
  const body = snapshot(1, 'pinned')
  const subject = recipe === 'file' ? openFile(() => JSON.stringify(body)) : openFetch(async () => body)
  const sibling =
    recipe === 'file'
      ? openFetch(async () => {
          throw new Error('sibling must not fetch')
        })
      : openFile(() => null)
  try {
    assert.equal(await subject.refresh('local'), null)
    assert.equal(subject.provider.read({ sourceRef: 'local', revision: 1 }).ok, true)
    subject.provider.dispose()
    subject.provider.dispose()
    const read = subject.provider.read({ sourceRef: 'local', revision: 1 })
    assert.equal(read.ok, false)
    if (!read.ok) assert.equal(read.refusal.code, 'disposed')
    const resolved = sibling.provider.resolve(chain())
    assert.equal(resolved.ok, true)
    if (!resolved.ok) {
      return evidence(recipe, providerDigest(recipe), providerDigest(recipe), 'sibling stopped')
    }
    assert.equal(sibling.loads(), 0)
    return evidence(recipe, resolved.result.profileDigest, resolved.result.sourceSetDigest, 'disposed')
  } finally {
    sibling.provider.dispose()
  }
}

const SCENARIO: Record<
  'select' | 'normal' | 'deny' | 'cancel' | 'recover' | 'dispose',
  (recipe: Recipe) => Promise<ReferenceConfigEvidence>
> = { select, normal, deny, cancel, recover, dispose }

export function referenceConfigPorts(): readonly ReferenceConfigPort[] {
  return (['file', 'fetch'] as const).map((recipe) => ({
    recipe,
    select: () => SCENARIO.select(recipe),
    normal: () => SCENARIO.normal(recipe),
    deny: () => SCENARIO.deny(recipe),
    cancel: () => SCENARIO.cancel(recipe),
    recover: () => SCENARIO.recover(recipe),
    dispose: () => SCENARIO.dispose(recipe),
  }))
}

export async function exerciseReferenceConfig(): Promise<void> {
  for (const port of referenceConfigPorts()) {
    for (const name of ['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'] as const) {
      const result = await port[name]()
      assert.equal(result.passed, true, `${port.recipe} ${name}`)
      assert.notEqual(result.detail, '')
      assert.match(result.providerDigest, /^[a-f0-9]{64}$/)
      assert.match(result.configDigest, /^[a-f0-9]{64}$/)
      assert.match(result.releaseSetDigest, /^[a-f0-9]{64}$/)
    }
  }
}
