import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { CheckpointSeam } from '@agnes/core'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { renameWriteThrough, syncDirectory } from '@agnes/system-node'
import {
  anyLiveLease,
  checked,
  confirmJournal,
  dropJournal,
  fileVersion,
  loadPin,
  noteJournal,
  parsed,
  prepareJournal,
  putFileVersion,
  readJournal,
  rememberPin,
  requireLease,
  runtimeError,
  StoreFault,
  type WorkspaceStore,
} from '../workspace-leases.js'

export const FILES_CONTRACT = 'agh.files'
export const DEFAULT_FILES_PROVIDER_ID = 'agh.default/files'

const [aghSecrets, agnesSecrets] = WORKSPACE_SECRET_DIRS
const HARD_DENY = [
  ['workspace', '.git'],
  ['workspace', aghSecrets],
  ['workspace', agnesSecrets],
  ['home', '.ssh'],
  ['data', 'secrets'],
] as const

export type FilePlaces = {
  home: { absolute: string; workspaceId: string; mountId: string }
  data: { absolute: string; workspaceId: string; mountId: string }
}

export type FilesCheckpoint = {
  snapshot(absolutePath: string, stepId: string): Promise<{ id: string }>
}

export type FilesServiceOptions = {
  store: WorkspaceStore
  authorityId: Wire.Id
  policy: Wire.FsPolicySnapshot
  places: FilePlaces
  providerId?: Wire.Id
  checkpoint?: FilesCheckpoint
  /** Runs after the renamed file is durable and before the journal confirms. */
  afterDurableWrite?: () => void
}

export type FilesService = {
  readonly binding: Wire.BindingRef
  readonly providerDigest: string
  stageBytes(bytes: Uint8Array, mediaType?: string): Promise<Outcome<Wire.BlobRef>>
  loadBytes(ref: Wire.BlobRef): Promise<Outcome<Uint8Array>>
  read(request: unknown, context: CallContext): Promise<Outcome<Wire.FilesReadResult>>
  write(request: unknown, context: CallContext): Promise<Outcome<Wire.FilesWriteResult>>
  list(request: unknown, context: CallContext): Promise<Outcome<Wire.FilesListResult>>
  stat(request: unknown, context: CallContext): Promise<Outcome<Wire.FileStat>>
  verifyPolicy(request: unknown, context: CallContext): Promise<Outcome<Wire.FsEnforcementProof>>
  authorityFence(request: unknown, context: CallContext): Promise<Outcome<never>>
  close(): void
}

type RootKind = 'workspace' | 'home' | 'data'
type Access = 'read' | 'write' | 'stat' | 'list'
type Intent = {
  before: 'present' | 'absent'
  beforeVersion: number | null
  beforeDigest: string
  pinId: string
  checkpointId: string | null
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function stamp(ms: number): Wire.Timestamp {
  return new Date(ms).toISOString()
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function posixRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute)
  if (rel === '') return ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new StoreFault('permission_denied', 'symlink escapes the mount')
  return sep === '/' ? rel : rel.split(sep).join('/')
}

function covers(rulePath: string, rel: string): boolean {
  if (rulePath === '' || rulePath === '.') return true
  return rel === rulePath || rel.startsWith(`${rulePath}/`)
}

function blocked(policy: Wire.FsPolicySnapshot, root: RootKind, rel: string, access: Access): boolean {
  let hard = false
  let winner: { effect: string; length: number } | undefined
  for (const rule of policy.rules) {
    if (rule.root !== root || !rule.access.includes(access) || !covers(rule.path, rel)) continue
    if (rule.effect === 'hard-deny') hard = true
    if (!winner || rule.path.length >= winner.length)
      winner = { effect: rule.effect, length: rule.path.length }
  }
  if (hard) return true
  return winner?.effect !== 'allow'
}

function segmentsOf(input: string): string[] {
  if (input.includes('\0') || input.includes('\\') || input.split('/').includes('..'))
    throw new StoreFault('invalid_request', 'path escapes the mount')
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input))
    throw new StoreFault('invalid_request', 'absolute path is refused')
  if (input === '' || input === '.') return []
  const parts = input.split('/')
  if (parts.some((part) => part === '' || part === '.'))
    throw new StoreFault('invalid_request', 'path escapes the mount')
  return parts
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

type Visit = {
  absolute: string
  exists: boolean
  kind: 'file' | 'directory' | 'other'
  linkPath: string | null
}

async function locate(root: string, rel: string, writing: boolean): Promise<Visit> {
  const parts = segmentsOf(rel)
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string
    const next = join(current, part)
    const final = index === parts.length - 1
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(next)
    } catch (error) {
      if (missing(error) && final) return { absolute: next, exists: false, kind: 'file', linkPath: null }
      if (missing(error)) throw new StoreFault('not_found', 'path is absent')
      throw error
    }
    if (info.isSymbolicLink()) {
      let pointed: string
      try {
        pointed = await realpath(next)
      } catch {
        throw new StoreFault('permission_denied', 'symlink escapes the mount')
      }
      if (!contained(root, pointed)) throw new StoreFault('permission_denied', 'symlink escapes the mount')
      if (final && writing) throw new StoreFault('permission_denied', 'symlink escapes the mount')
      if (final) {
        const again = await realpath(next)
        if (again !== pointed || !contained(root, again))
          throw new StoreFault('permission_denied', 'symlink escapes the mount')
        const target = await lstat(again)
        const kind = target.isFile() ? 'file' : target.isDirectory() ? 'directory' : 'other'
        return { absolute: again, exists: true, kind, linkPath: next }
      }
      current = pointed
      continue
    }
    current = next
    if (final) {
      const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
      return { absolute: next, exists: true, kind, linkPath: null }
    }
    if (!info.isDirectory()) throw new StoreFault('invalid_request', 'path escapes the mount')
  }
  return { absolute: root, exists: true, kind: 'directory', linkPath: null }
}

async function readRegular(absolute: string): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    throw new StoreFault('permission_denied', 'symlink escapes the mount')
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new StoreFault('invalid_request', 'path escapes the mount')
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function guard<T>(context: CallContext, body: () => Promise<T>): Promise<Outcome<T>> {
  if (context.signal.aborted) return { ok: false, error: runtimeError('cancelled', 'call was cancelled') }
  try {
    return { ok: true, value: await body() }
  } catch (error) {
    if (error instanceof StoreFault) return { ok: false, error: runtimeError(error.detail, error.message) }
    throw error
  }
}

function policyBodyDigest(snapshot: Wire.FsPolicySnapshot): string {
  return canonicalJsonDigest({
    compilerVersion: snapshot.compilerVersion,
    policyId: snapshot.policyId,
    roots: snapshot.roots,
    rules: snapshot.rules,
    scope: snapshot.scope,
  })
}

export function checkpointFromSeam(seam: Pick<CheckpointSeam, 'snapshot'>): FilesCheckpoint {
  return {
    snapshot: (absolutePath, stepId) => seam.snapshot([absolutePath], stepId),
  }
}

export function createFilesService(options: FilesServiceOptions): FilesService {
  const providerId = options.providerId ?? DEFAULT_FILES_PROVIDER_ID
  let closed = false
  const binding = checked('BindingRef', {
    bindingId: `${providerId}/binding`,
    contract: FILES_CONTRACT,
    logicalName: 'files',
    providerId,
  })
  const providerDigest = canonicalJsonDigest({
    contract: FILES_CONTRACT,
    providerId,
    recipe: 'local-content',
  })
  const live = () => {
    if (closed) throw new StoreFault('blocked', 'service is closed')
  }
  const pinFile = (digest: string) => join(options.store.directory, 'pins', digest)

  async function retain(bytes: Uint8Array, mediaType: string): Promise<Wire.BlobRef> {
    live()
    const digest = sha256(bytes)
    const pinId = randomUUID()
    const path = pinFile(digest)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    rememberPin(options.store, { pinId, digest, byteLength: bytes.byteLength, mediaType })
    return checked('BlobRef', {
      authorityId: options.authorityId,
      blobId: pinId,
      digest,
      bytes: bytes.byteLength,
      mediaType,
      pinId,
    })
  }

  async function materialize(ref: Wire.BlobRef): Promise<Uint8Array> {
    live()
    if (ref.authorityId !== options.authorityId)
      throw new StoreFault('not_found', 'bytes belong to another authority')
    const pin = loadPin(options.store, ref.pinId)
    if (!pin || pin.digest !== ref.digest || pin.byteLength !== ref.bytes)
      throw new StoreFault('not_found', 'bytes are not retained')
    const bytes = await readFile(pinFile(ref.digest))
    if (sha256(bytes) !== ref.digest || bytes.byteLength !== ref.bytes)
      throw new StoreFault('integrity', 'retained bytes do not match their digest')
    return bytes
  }

  function enforce(rel: string, access: Access): void {
    if (blocked(options.policy, 'workspace', rel, access))
      throw new StoreFault('permission_denied', 'hard deny')
  }

  function enforceVisit(root: string, absolute: string, lexical: string, access: Access): void {
    enforce(lexical, access)
    const real = posixRelative(root, absolute)
    if (real !== lexical) enforce(real, access)
  }

  function leaseFor(mount: Wire.MountRef, context: CallContext, writing: boolean) {
    return requireLease(options.store, { mount, ownerId: context.principalRef, writing })
  }

  async function diskDigest(absolute: string, exists: boolean): Promise<string | null> {
    if (!exists) return null
    return sha256(await readRegular(absolute))
  }

  function proofOf(path: string, requestId: string, intent: Intent): Wire.FileCheckpointProof {
    const restoration =
      intent.checkpointId === null
        ? {
            kind: 'blob' as const,
            authorityId: options.authorityId,
            resourceId: intent.pinId,
            version: '1',
            digest: intent.beforeDigest,
            pinId: intent.pinId,
          }
        : {
            kind: 'domain-record' as const,
            authorityId: options.authorityId,
            resourceId: intent.checkpointId,
            version: '1',
            digest: intent.beforeDigest,
            pinId: intent.pinId,
          }
    return checked('FileCheckpointProof', {
      requestId,
      path,
      beforeVersion: intent.beforeVersion,
      before: intent.before,
      restoration,
      digest: intent.beforeDigest,
    })
  }

  function resultOf(path: string, requestId: string, intent: Intent, version: number, digest: string) {
    return checked('FilesWriteResult', {
      version,
      digest,
      checkpoint: proofOf(path, requestId, intent),
    })
  }

  return {
    binding,
    providerDigest,
    async stageBytes(bytes, mediaType = 'application/octet-stream') {
      try {
        return { ok: true, value: await retain(bytes, mediaType) }
      } catch (error) {
        if (error instanceof StoreFault)
          return { ok: false, error: runtimeError(error.detail, error.message) }
        throw error
      }
    },
    async loadBytes(ref) {
      try {
        return { ok: true, value: await materialize(ref) }
      } catch (error) {
        if (error instanceof StoreFault)
          return { ok: false, error: runtimeError(error.detail, error.message) }
        throw error
      }
    },
    read(request, context) {
      return guard(context, async () => {
        live()
        const body = parsed('FilesReadRequest', request)
        const held = leaseFor(body.mountRef, context, false)
        const found = await locate(held.canonicalRoot, body.path, false)
        if (!found.exists || found.kind !== 'file') throw new StoreFault('not_found', 'path is absent')
        enforceVisit(held.canonicalRoot, found.absolute, body.path, 'read')
        const version = fileVersion(options.store, held.workspaceId, body.path).version
        if (body.expectedVersion !== null && body.expectedVersion !== version)
          throw new StoreFault('revision_conflict', 'version does not match')
        const bytes = await readRegular(found.absolute)
        const slice =
          body.range === null
            ? bytes
            : bytes.subarray(body.range.offset, body.range.offset + body.range.length)
        if (body.range !== null && body.range.offset + body.range.length > bytes.byteLength)
          throw new StoreFault('range_not_satisfiable', 'range exceeds the file')
        const retained = await retain(slice, 'application/octet-stream')
        return checked('FilesReadResult', { bytesRef: retained, version })
      })
    },
    write(request, context) {
      return guard(context, async () => {
        live()
        const body = parsed('FilesWriteRequest', request)
        const held = leaseFor(body.mountRef, context, true)
        const found = await locate(held.canonicalRoot, body.path, true)
        enforceVisit(held.canonicalRoot, found.absolute, body.path, 'write')
        if (found.exists && found.kind !== 'file')
          throw new StoreFault('invalid_request', 'path escapes the mount')
        const bytes = await materialize(body.bytesRef)
        const digest = sha256(bytes)
        const prior = readJournal(options.store, context.invocationId)
        const onDisk = await diskDigest(found.absolute, found.exists)
        if (prior && prior.workspaceId === held.workspaceId && prior.path === body.path) {
          if (prior.digest !== digest) {
            throw new StoreFault(
              prior.state === 'confirmed' ? 'idempotency_conflict' : 'effect_unknown',
              prior.state === 'confirmed' ? 'invocation already wrote different bytes' : 'effect is unknown',
            )
          }
          if (onDisk !== digest) throw new StoreFault('effect_unknown', 'effect is unknown')
          if (prior.state === 'confirmed' && prior.resultJson)
            return parsed('FilesWriteResult', JSON.parse(prior.resultJson) as unknown)
          const intent = JSON.parse(prior.resultJson ?? 'null') as Intent | null
          if (!intent) throw new StoreFault('effect_unknown', 'effect is unknown')
          try {
            await syncDirectory(dirname(found.absolute), { noFollow: true })
          } catch {
            throw new StoreFault('effect_unknown', 'effect is unknown')
          }
          putFileVersion(options.store, {
            workspaceId: held.workspaceId,
            path: body.path,
            version: prior.version,
            digest,
          })
          const result = resultOf(body.path, context.invocationId, intent, prior.version, digest)
          confirmJournal(options.store, context.invocationId, JSON.stringify(result))
          return result
        }
        if (prior) throw new StoreFault('idempotency_conflict', 'invocation already wrote another path')
        const recorded = fileVersion(options.store, held.workspaceId, body.path)
        const observed = found.exists ? recorded.version : 0
        if (body.expectedVersion.kind === 'absent' && found.exists)
          throw new StoreFault('revision_conflict', 'version does not match')
        if (body.expectedVersion.kind === 'exact' && body.expectedVersion.revision !== observed)
          throw new StoreFault('revision_conflict', 'version does not match')
        const version = observed + 1
        prepareJournal(options.store, {
          invocationId: context.invocationId,
          workspaceId: held.workspaceId,
          path: body.path,
          digest,
          version,
        })
        const beforeBytes = found.exists ? await readRegular(found.absolute) : new Uint8Array()
        const beforePin = await retain(beforeBytes, 'application/octet-stream')
        let checkpointId: string | null = null
        try {
          if (options.checkpoint)
            checkpointId = (await options.checkpoint.snapshot(found.absolute, context.invocationId)).id
        } catch {
          dropJournal(options.store, context.invocationId)
          throw new StoreFault('blocked', 'checkpoint failed')
        }
        const intent: Intent = {
          before: found.exists ? 'present' : 'absent',
          beforeVersion: found.exists ? observed : null,
          beforeDigest: sha256(beforeBytes),
          pinId: beforePin.pinId,
          checkpointId,
        }
        noteJournal(options.store, context.invocationId, JSON.stringify(intent))
        const partial = join(dirname(found.absolute), `.${randomUUID()}.partial`)
        try {
          const handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
          try {
            await handle.writeFile(bytes)
            await handle.sync()
          } finally {
            await handle.close()
          }
          await renameWriteThrough(partial, found.absolute, { noFollow: true })
        } catch {
          await rm(partial, { force: true })
          throw new StoreFault('effect_unknown', 'effect is unknown')
        }
        try {
          options.afterDurableWrite?.()
        } catch {
          throw new StoreFault('effect_unknown', 'effect is unknown')
        }
        putFileVersion(options.store, { workspaceId: held.workspaceId, path: body.path, version, digest })
        const result = resultOf(body.path, context.invocationId, intent, version, digest)
        confirmJournal(options.store, context.invocationId, JSON.stringify(result))
        return result
      })
    },
    list(request, context) {
      return guard(context, async () => {
        live()
        const body = parsed('FilesListRequest', request)
        if (body.limit < 1 || body.limit > 10_000)
          throw new StoreFault('invalid_request', 'list limit is invalid')
        const held = leaseFor(body.mountRef, context, false)
        const found = await locate(held.canonicalRoot, body.path, false)
        if (!found.exists || found.kind !== 'directory') throw new StoreFault('not_found', 'path is absent')
        enforceVisit(held.canonicalRoot, found.absolute, body.path, 'list')
        const names = (await readdir(found.absolute)).sort()
        const entries: Wire.FileEntry[] = []
        for (const name of names) {
          const rel = body.path === '' || body.path === '.' ? name : `${body.path}/${name}`
          if (blocked(options.policy, 'workspace', rel, 'list')) continue
          const info = await lstat(join(found.absolute, name))
          const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file'
          if (kind === 'symlink' || kind === 'file' || kind === 'directory') {
            entries.push(
              checked('FileEntry', {
                path: rel,
                kind: kind === 'symlink' ? 'symlink' : kind,
                bytes: kind === 'file' ? info.size : null,
                revision: fileVersion(options.store, held.workspaceId, rel).version,
              }),
            )
          }
        }
        const start = body.cursor === null ? 0 : Number(body.cursor)
        if (!Number.isInteger(start) || start < 0 || String(start) !== (body.cursor ?? '0'))
          throw new StoreFault('invalid_request', 'list cursor is invalid')
        const page = entries.slice(start, start + body.limit)
        const next = start + body.limit < entries.length ? String(start + body.limit) : null
        return checked('FilesListResult', {
          items: page,
          snapshot: sha256(Buffer.from(entries.map((entry) => entry.path).join('\n'))),
          nextCursor: next,
          complete: next === null,
        })
      })
    },
    stat(request, context) {
      return guard(context, async () => {
        live()
        const body = parsed('FilesStatRequest', request)
        const held = leaseFor(body.mountRef, context, false)
        const found = await locate(held.canonicalRoot, body.path, false)
        if (!found.exists) throw new StoreFault('not_found', 'path is absent')
        enforceVisit(held.canonicalRoot, found.absolute, body.path, 'stat')
        const info = await lstat(found.linkPath ?? found.absolute)
        const kind = found.linkPath
          ? 'symlink'
          : info.isFile()
            ? 'file'
            : info.isDirectory()
              ? 'directory'
              : 'other'
        return checked('FileStat', {
          kind,
          bytes: kind === 'file' || kind === 'symlink' ? info.size : 0,
          mtimeMs: info.mtimeMs,
          version: fileVersion(options.store, held.workspaceId, body.path).version,
        })
      })
    },
    verifyPolicy(request, context) {
      return guard(context, async () => {
        live()
        const snapshot = parsed('FsPolicySnapshot', request)
        if (snapshot.digest !== policyBodyDigest(snapshot))
          throw new StoreFault('integrity', 'policy digest does not match')
        if (canonicalJsonDigest(context.scope) !== canonicalJsonDigest(snapshot.scope))
          throw new StoreFault('permission_denied', 'workspace is outside the caller scope')
        for (const [root, path] of HARD_DENY) {
          const present = snapshot.rules.some(
            (rule) => rule.root === root && rule.path === path && rule.effect === 'hard-deny',
          )
          if (!present) throw new StoreFault('invalid_request', 'hard deny is incomplete')
        }
        const workspaceRoot = snapshot.roots.find((item) => item.kind === 'workspace')
        if (!workspaceRoot) throw new StoreFault('invalid_request', 'hard deny is incomplete')
        const held = anyLiveLease(options.store, workspaceRoot.mount.workspaceId, context.principalRef)
        if (!held) throw new StoreFault('revoked', 'mount lease is not live')
        let exists = true
        try {
          const info = await stat(held.canonicalRoot)
          if (!info.isDirectory())
            throw new StoreFault('invalid_request', 'workspace root is not a directory')
        } catch (error) {
          if (!missing(error)) throw error
          exists = false
        }
        const probes: Wire.FsEnforcementProof['probes'][number][] = []
        const directories: Record<RootKind, string> = {
          workspace: held.canonicalRoot,
          home: options.places.home.absolute,
          data: options.places.data.absolute,
        }
        for (const [root, path] of HARD_DENY) {
          try {
            await stat(join(directories[root], path))
          } catch (error) {
            if (missing(error)) throw new StoreFault('integrity', 'hard deny path is absent')
            throw error
          }
          if (!blocked(snapshot, root, path, 'read'))
            throw new StoreFault('invalid_request', 'hard deny is not enforced')
          probes.push({ root, path, decision: 'denied', evidenceCode: 'E_FS_DENIED' })
        }
        const leaseRef = checked('LeaseRef', {
          authorityId: options.authorityId,
          leaseId: held.leaseId,
          epoch: held.epoch,
          expiresAt: stamp(held.expiresAt),
        })
        const body = {
          policyDigest: snapshot.digest,
          provider: binding,
          authorityEpoch: held.epoch,
          checkedAt: stamp(options.store.now()),
          scope: snapshot.scope,
          workspaceRoot: {
            mount: {
              workspaceId: held.workspaceId,
              mountId: held.mountId,
              revision: held.revision,
              lease: leaseRef,
            },
            policyDecision: 'allow' as const,
            exists,
          },
          probes,
        }
        return checked('FsEnforcementProof', { ...body, digest: canonicalJsonDigest(body) })
      })
    },
    authorityFence(_request, context) {
      if (closed) return Promise.resolve({ ok: false, error: runtimeError('blocked', 'service is closed') })
      if (context.signal.aborted)
        return Promise.resolve({ ok: false, error: runtimeError('cancelled', 'call was cancelled') })
      return Promise.resolve({
        ok: false,
        error: runtimeError('unsupported', 'authority transfer is not supported'),
      })
    },
    close() {
      closed = true
    },
  }
}
