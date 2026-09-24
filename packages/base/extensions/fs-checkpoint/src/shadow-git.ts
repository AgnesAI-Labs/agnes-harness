import { createHash } from 'node:crypto'
// biome-ignore format: plumbing names are clearer together and the extension has a strict line budget.
import { init as initGit, listRefs, readBlob, readCommit, deleteRef as removeRef, resolveRef, writeBlob, writeCommit, writeRef, writeTree } from 'isomorphic-git'
import type { HostFs } from '../../../src/seam-init.js'
import { toGitFs } from './git-fs.js'

const decoder = new TextDecoder()
const encoder = new TextEncoder()
const ID = /^[0-9a-f]{32}$/
const HASH = /^[0-9a-f]{64}$/
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const fault = (code: string, message: string) => Object.assign(new Error(`${code}: ${message}`), { code })
// biome-ignore format: keep the complete hostile-error check visible as one predicate.
const missing = (error: unknown) => typeof error === 'object' && error !== null && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT'

export type ManifestEntry =
  | { rel: string; state: 'absent' }
  | { rel: string; state: 'file'; payload: string; size: number; sha256: string }
export type CheckpointManifest = {
  schema: 1
  id: string
  workspaceHash: string
  stepId: string
  createdAt: number
  entries: ManifestEntry[]
}
export type Captured =
  | { rel: string; state: 'absent' }
  | { rel: string; state: 'file'; bytes: Uint8Array; size: number; sha256: string }

function validate(value: unknown, id: string, workspaceHash: string): CheckpointManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw fault('E_CHECKPOINT_CORRUPT', `${id} manifest`)
  const manifest = value as Partial<CheckpointManifest>
  // biome-ignore format: this is one manifest-header invariant.
  if (manifest.schema !== 1 || manifest.id !== id || manifest.workspaceHash !== workspaceHash || typeof manifest.stepId !== 'string' || !Number.isSafeInteger(manifest.createdAt) || !Array.isArray(manifest.entries))
    throw fault('E_CHECKPOINT_CORRUPT', `${id} manifest fields`)
  let previous = ''
  for (const entry of manifest.entries) {
    // biome-ignore format: this is one canonical-relative-path invariant.
    if (!entry || typeof entry !== 'object' || typeof entry.rel !== 'string' || entry.rel <= previous || entry.rel.includes('\\') || entry.rel.split('/').some((part) => part === '' || part === '.' || part === '..'))
      throw fault('E_CHECKPOINT_CORRUPT', `${id} entry order`)
    previous = entry.rel
    if (entry.state === 'absent') continue
    // biome-ignore format: this is one file-entry invariant.
    if (entry.state !== 'file' || !HASH.test(entry.sha256) || entry.payload !== `payload/${digest(entry.rel)}` || !Number.isSafeInteger(entry.size) || entry.size < 0)
      throw fault('E_CHECKPOINT_CORRUPT', `${id} file entry`)
  }
  return manifest as CheckpointManifest
}

export class ShadowGit {
  readonly fs
  private workspaceHash = ''
  // biome-ignore format: the adapter and its relative gitdir are one construction pair.
  constructor(dataFs: HostFs, readonly gitdir: string) { this.fs = toGitFs(dataFs) }

  async init(identity: { workspaceHash: string }): Promise<void> {
    this.workspaceHash = identity.workspaceHash
    const path = `${this.gitdir}/identity.json`
    let found: unknown
    try {
      const raw = await this.fs.promises.readFile(path)
      try {
        found = JSON.parse(decoder.decode(typeof raw === 'string' ? encoder.encode(raw) : raw))
      } catch {
        throw fault('E_CHECKPOINT_IDENTITY', `invalid identity at ${this.gitdir}`)
      }
    } catch (error) {
      if (!missing(error)) throw error
      try {
        await this.fs.promises.stat(this.gitdir)
        throw fault('E_CHECKPOINT_IDENTITY', `missing identity at ${this.gitdir}`)
      } catch (statError) {
        if (!missing(statError)) throw statError
      }
      await initGit({ fs: this.fs, gitdir: this.gitdir, bare: true, defaultBranch: 'unused' })
      // biome-ignore format: identity is intentionally tiny and atomic at the adapter boundary.
      await this.fs.promises.writeFile(path, encoder.encode(JSON.stringify({ schema: 1, workspaceHash: identity.workspaceHash })))
      return
    }
    // biome-ignore format: identity format and full hash are one collision guard.
    if ((found as { schema?: unknown })?.schema !== 1 || (found as { workspaceHash?: unknown })?.workspaceHash !== identity.workspaceHash)
      throw fault('E_CHECKPOINT_IDENTITY', `repository prefix collision at ${this.gitdir}`)
  }

  async create(input: { id: string; stepId: string; createdAt: number; files: Captured[] }): Promise<void> {
    if (!ID.test(input.id)) throw fault('E_CHECKPOINT_ID', input.id)
    const entries: ManifestEntry[] = []
    const payloads: Array<{ path: string; oid: string }> = []
    for (const file of input.files) {
      if (file.state === 'absent') entries.push({ rel: file.rel, state: 'absent' })
      else {
        const path = digest(file.rel)
        payloads.push({ path, oid: await writeBlob({ fs: this.fs, gitdir: this.gitdir, blob: file.bytes }) })
        // biome-ignore format: this mirrors the compact manifest schema.
        entries.push({ rel: file.rel, state: 'file', payload: `payload/${path}`, size: file.size, sha256: file.sha256 })
      }
    }
    entries.sort((a, b) => a.rel.localeCompare(b.rel))
    // biome-ignore format: this mirrors the compact manifest schema.
    const manifest: CheckpointManifest = { schema: 1, id: input.id, workspaceHash: this.workspaceHash, stepId: input.stepId, createdAt: input.createdAt, entries }
    // biome-ignore format: one plumbing operation.
    const manifestOid = await writeBlob({ fs: this.fs, gitdir: this.gitdir, blob: encoder.encode(JSON.stringify(manifest)) })
    // biome-ignore format: one root-tree declaration.
    const tree: Array<{ mode: '100644' | '040000'; path: string; oid: string; type: 'blob' | 'tree' }> = [{ mode: '100644', path: 'manifest.json', oid: manifestOid, type: 'blob' }]
    if (payloads.length)
      // biome-ignore format: the nested tree is one plumbing operation.
      tree.push({ mode: '040000', path: 'payload', type: 'tree', oid: await writeTree({ fs: this.fs, gitdir: this.gitdir, tree: payloads.sort((a, b) => a.path.localeCompare(b.path)).map(({ path, oid }) => ({ mode: '100644', path, oid, type: 'blob' })) }) })
    const treeOid = await writeTree({ fs: this.fs, gitdir: this.gitdir, tree })
    // biome-ignore format: author identity is fixed metadata.
    const who = { name: 'agnes', email: 'checkpoint@local', timestamp: Math.floor(input.createdAt / 1000), timezoneOffset: 0 }
    // biome-ignore format: one parentless plumbing operation.
    const oid = await writeCommit({ fs: this.fs, gitdir: this.gitdir, commit: { tree: treeOid, parent: [], author: who, committer: who, message: `checkpoint ${input.id}\n` } })
    await this.readAt(oid, input.id)
    // biome-ignore format: the ref is the checkpoint visibility boundary.
    await writeRef({ fs: this.fs, gitdir: this.gitdir, ref: `refs/agnes/checkpoints/${input.id}`, value: oid, force: false })
  }

  private async readAt(oid: string, id: string) {
    const { commit } = await readCommit({ fs: this.fs, gitdir: this.gitdir, oid })
    if (commit.parent.length) throw fault('E_CHECKPOINT_CORRUPT', `${id} has parents`)
    const raw = (await readBlob({ fs: this.fs, gitdir: this.gitdir, oid, filepath: 'manifest.json' })).blob
    let parsed: unknown
    try {
      parsed = JSON.parse(decoder.decode(raw))
    } catch {
      throw fault('E_CHECKPOINT_CORRUPT', `${id} manifest JSON`)
    }
    const manifest = validate(parsed, id, this.workspaceHash)
    const files = new Map<string, Uint8Array>()
    for (const entry of manifest.entries)
      if (entry.state === 'file') {
        const blob = (await readBlob({ fs: this.fs, gitdir: this.gitdir, oid, filepath: entry.payload })).blob
        if (blob.length !== entry.size || digest(blob) !== entry.sha256)
          throw fault('E_CHECKPOINT_CORRUPT', `${id} payload`)
        files.set(entry.rel, blob)
      }
    return { manifest, files }
  }

  async read(id: string) {
    if (!ID.test(id)) throw fault('E_CHECKPOINT_ID', id)
    const oid = await resolveRef({ fs: this.fs, gitdir: this.gitdir, ref: `refs/agnes/checkpoints/${id}` })
    return this.readAt(oid, id)
  }

  async list(): Promise<CheckpointManifest[]> {
    let ids: string[]
    try {
      ids = await listRefs({ fs: this.fs, gitdir: this.gitdir, filepath: 'refs/agnes/checkpoints' })
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
    for (const id of ids) if (!ID.test(id)) throw fault('E_CHECKPOINT_CORRUPT', `invalid ref ${id}`)
    const rows = await Promise.all(ids.map(async (id) => (await this.read(id)).manifest))
    return rows.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  }

  async deleteRef(id: string): Promise<void> {
    await removeRef({ fs: this.fs, gitdir: this.gitdir, ref: `refs/agnes/checkpoints/${id}` })
  }

  async gc(input: { keep: number; now: number; maxAgeMs: number }): Promise<{ deleted: string[] }> {
    const deleted: string[] = []
    for (const manifest of (await this.list()).slice(input.keep))
      if (manifest.createdAt < input.now - input.maxAgeMs) {
        await this.deleteRef(manifest.id)
        deleted.push(manifest.id)
      }
    const remaining = new Set((await this.list()).map((item) => item.id))
    if (deleted.some((id) => remaining.has(id))) throw fault('E_CHECKPOINT_GC', 'deleted ref remains visible')
    return { deleted }
  }
}
