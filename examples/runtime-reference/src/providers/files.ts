import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { admit, demand, fault, fold, Halt, type ReferenceDesk } from './workspace.js'

export const REFERENCE_FILES_CONTRACT = 'agh.files'
export const REFERENCE_FILES_PROVIDER_ID = 'agh.reference/files'

const FLOOR = [
  ['workspace', '.git'],
  ['workspace', '.agh/secrets'],
  ['workspace', '.agnes/secrets'],
  ['home', '.ssh'],
  ['data', 'secrets'],
] as const

type RootKind = 'workspace' | 'home' | 'data'
type Access = 'read' | 'write' | 'stat' | 'list'
type Mark = {
  root: RootKind
  path: string
  effect: 'allow' | 'deny' | 'hard-deny'
  access: Set<Access>
  index: number
}

class Fence {
  private readonly marks: Mark[]
  constructor(rules: Wire.FsPolicySnapshot['rules']) {
    this.marks = rules.map((rule, index) => ({
      root: rule.root,
      path: rule.path,
      effect: rule.effect,
      access: new Set(rule.access),
      index,
    }))
  }
  blocks(root: RootKind, rel: string, access: Access): boolean {
    let hard = false
    let winner: { effect: 'allow' | 'deny'; length: number; index: number } | undefined
    for (const mark of this.marks) {
      if (mark.root !== root || !mark.access.has(access) || !covers(mark.path, rel)) continue
      if (mark.effect === 'hard-deny') hard = true
      else if (
        !winner ||
        mark.path.length > winner.length ||
        (mark.path.length === winner.length && mark.index >= winner.index)
      )
        winner = { effect: mark.effect, length: mark.path.length, index: mark.index }
    }
    if (hard) return true
    return winner?.effect !== 'allow'
  }
}

function covers(rulePath: string, rel: string): boolean {
  if (rulePath.length === 0 || rulePath === '.') return true
  return rel === rulePath || rel.startsWith(`${rulePath}/`)
}

function pieces(input: string): string[] {
  const escaped = input.split('/').includes('..') || input.includes('\0') || input.includes('\\')
  if (escaped) throw new Halt('invalid_request', 'path escapes the mount')
  const drive = /^[A-Za-z]:/.test(input)
  if (drive || input.charAt(0) === '/') throw new Halt('invalid_request', 'absolute path is refused')
  if (input.length === 0 || input === '.') return []
  const parts = input.split('/')
  if (parts.includes('') || parts.includes('.')) throw new Halt('invalid_request', 'path escapes the mount')
  return parts
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel))
}

function fromRoot(root: string, absolute: string): string {
  const rel = relative(root, absolute)
  if (rel.length === 0) return ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Halt('permission_denied', 'symlink escapes the mount')
  return sep === '/' ? rel : rel.split(sep).join('/')
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

type Visit = { absolute: string; exists: boolean; kind: 'file' | 'directory' | 'other'; link: string | null }

async function walk(root: string, rel: string, writing: boolean): Promise<Visit> {
  const parts = pieces(rel)
  let cursor = root
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string
    const next = join(cursor, part)
    const last = index + 1 === parts.length
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(next)
    } catch (error) {
      if (absent(error) && last) return { absolute: next, exists: false, kind: 'file', link: null }
      if (absent(error)) throw new Halt('not_found', 'path is absent')
      throw error
    }
    if (info.isSymbolicLink()) {
      let pointed: string
      try {
        pointed = await realpath(next)
      } catch {
        throw new Halt('permission_denied', 'symlink escapes the mount')
      }
      if (!inside(root, pointed)) throw new Halt('permission_denied', 'symlink escapes the mount')
      if (last && writing) throw new Halt('permission_denied', 'symlink escapes the mount')
      if (last) {
        const again = await realpath(next)
        if (again !== pointed || !inside(root, again))
          throw new Halt('permission_denied', 'symlink escapes the mount')
        const target = await lstat(again)
        const kind = target.isFile() ? 'file' : target.isDirectory() ? 'directory' : 'other'
        return { absolute: again, exists: true, kind, link: next }
      }
      cursor = pointed
      continue
    }
    if (last) {
      const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
      return { absolute: next, exists: true, kind, link: null }
    }
    if (!info.isDirectory()) throw new Halt('invalid_request', 'path escapes the mount')
    cursor = next
  }
  return { absolute: root, exists: true, kind: 'directory', link: null }
}

async function slurp(absolute: string): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    throw new Halt('permission_denied', 'symlink escapes the mount')
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Halt('invalid_request', 'path escapes the mount')
    return new Uint8Array(await handle.readFile())
  } finally {
    await handle.close()
  }
}

type Intent = {
  before: 'present' | 'absent'
  beforeVersion: number | null
  beforeDigest: string
  pinId: string
  checkpointId: string | null
}

type Job = {
  phase: 'intent' | 'landed'
  workspaceId: string
  path: string
  digest: string
  version: number
  intent: Intent | null
  result: Wire.FilesWriteResult | null
}

function jobs(desk: ReferenceDesk): Map<string, Job> {
  const found = new Map<string, Job>()
  for (const note of desk.notes()) {
    if (note.kind === 'intent' || note.kind === 'landed') found.set(note.key, note.body as Job)
  }
  return found
}

function versions(desk: ReferenceDesk): Map<string, { version: number; digest: string | null }> {
  const found = new Map<string, { version: number; digest: string | null }>()
  for (const note of desk.notes()) {
    if (note.kind === 'version') found.set(note.key, note.body as { version: number; digest: string | null })
  }
  return found
}

function pins(desk: ReferenceDesk): Map<string, { digest: string; byteLength: number; mediaType: string }> {
  const found = new Map<string, { digest: string; byteLength: number; mediaType: string }>()
  for (const note of desk.notes()) {
    if (note.kind === 'pin')
      found.set(note.key, note.body as { digest: string; byteLength: number; mediaType: string })
  }
  return found
}

export type ReferenceFiles = {
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

export function createReferenceFiles(options: {
  desk: ReferenceDesk
  authorityId: Wire.Id
  policy: Wire.FsPolicySnapshot
  places: { home: string; data: string }
  providerId?: Wire.Id
  checkpoint?: { snapshot(absolutePath: string, stepId: string): Promise<{ id: string }> }
  stall?: 'landed'
  remote?: boolean
}): ReferenceFiles {
  const providerId = options.providerId ?? REFERENCE_FILES_PROVIDER_ID
  const fence = new Fence(options.policy.rules)
  let closed = false
  const binding = admit('BindingRef', {
    bindingId: `${providerId}/binding`,
    contract: REFERENCE_FILES_CONTRACT,
    logicalName: 'files',
    providerId,
  })
  const providerDigest = canonicalJsonDigest({
    contract: REFERENCE_FILES_CONTRACT,
    providerId,
    recipe: 'tree-cabinet',
  })
  const live = () => {
    if (closed || options.desk.shut) throw new Halt('blocked', 'service is closed')
  }
  const pinPath = (digest: string) => join(options.desk.directory, 'pins', digest)

  async function keep(bytes: Uint8Array, mediaType: string): Promise<Wire.BlobRef> {
    live()
    const digest = sha(bytes)
    const pinId = randomUUID()
    const path = pinPath(digest)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    options.desk.append('pin', pinId, { digest, byteLength: bytes.byteLength, mediaType })
    return admit('BlobRef', {
      authorityId: options.authorityId,
      blobId: pinId,
      digest,
      bytes: bytes.byteLength,
      mediaType,
      pinId,
    })
  }

  async function recall(ref: Wire.BlobRef): Promise<Uint8Array> {
    live()
    if (ref.authorityId !== options.authorityId)
      throw new Halt('not_found', 'bytes belong to another authority')
    const pin = pins(options.desk).get(ref.pinId)
    if (!pin || pin.digest !== ref.digest || pin.byteLength !== ref.bytes)
      throw new Halt('not_found', 'bytes are not retained')
    const bytes = new Uint8Array(await readFile(pinPath(ref.digest)))
    if (sha(bytes) !== ref.digest || bytes.byteLength !== ref.bytes)
      throw new Halt('integrity', 'retained bytes do not match their digest')
    return bytes
  }

  function rejectRemote(): void {
    if (options.remote) throw new Halt('unsupported', 'remote workspace transport is not supported')
  }

  function guardPath(root: string, absolute: string, lexical: string, access: Access): void {
    if (fence.blocks('workspace', lexical, access)) throw new Halt('permission_denied', 'hard deny')
    const real = fromRoot(root, absolute)
    if (real !== lexical && fence.blocks('workspace', real, access))
      throw new Halt('permission_denied', 'hard deny')
  }

  function leaseRoot(mount: Wire.MountRef, context: CallContext, writing: boolean) {
    const shot = fold(options.desk)
    const space = shot.spaces.get(mount.workspaceId)
    if (!space) throw new Halt('not_found', 'workspace is not bound')
    if (mount.revision !== space.revision) throw new Halt('revision_conflict', 'version does not match')
    const lease = shot.leases.find((item) => item.leaseId === mount.lease.leaseId)
    if (
      !lease ||
      lease.released ||
      lease.epoch !== mount.lease.epoch ||
      lease.mountId !== mount.mountId ||
      lease.workspaceId !== mount.workspaceId
    )
      throw new Halt('revoked', 'mount lease is not live')
    if (lease.ownerId !== context.principalRef)
      throw new Halt('permission_denied', 'workspace is outside the caller scope')
    if (writing && lease.mode !== 'write') throw new Halt('permission_denied', 'mount lease is not live')
    return { root: space.root, workspaceId: mount.workspaceId, lease }
  }

  function observedVersion(workspaceId: string, path: string, exists: boolean): number {
    if (!exists) return 0
    return versions(options.desk).get(`${workspaceId}\0${path}`)?.version ?? 0
  }

  function proof(path: string, requestId: string, intent: Intent): Wire.FileCheckpointProof {
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
    return admit('FileCheckpointProof', {
      requestId,
      path,
      beforeVersion: intent.beforeVersion,
      before: intent.before,
      restoration,
      digest: intent.beforeDigest,
    })
  }

  function written(path: string, requestId: string, intent: Intent, version: number, digest: string) {
    return admit('FilesWriteResult', { version, digest, checkpoint: proof(path, requestId, intent) })
  }

  async function guarded<T>(context: CallContext, body: () => Promise<T>): Promise<Outcome<T>> {
    if (context.signal.aborted) return { ok: false, error: fault('cancelled', 'call was cancelled') }
    try {
      return { ok: true, value: await body() }
    } catch (error) {
      if (error instanceof Halt) return { ok: false, error: fault(error.detail, error.message) }
      throw error
    }
  }

  return {
    binding,
    providerDigest,
    async stageBytes(bytes, mediaType = 'application/octet-stream') {
      try {
        return { ok: true, value: await keep(bytes, mediaType) }
      } catch (error) {
        if (error instanceof Halt) return { ok: false, error: fault(error.detail, error.message) }
        throw error
      }
    },
    async loadBytes(ref) {
      try {
        return { ok: true, value: await recall(ref) }
      } catch (error) {
        if (error instanceof Halt) return { ok: false, error: fault(error.detail, error.message) }
        throw error
      }
    },
    read(request, context) {
      return guarded(context, async () => {
        live()
        rejectRemote()
        const body = demand('FilesReadRequest', request)
        const held = leaseRoot(body.mountRef, context, false)
        const found = await walk(held.root, body.path, false)
        if (!found.exists || found.kind !== 'file') throw new Halt('not_found', 'path is absent')
        guardPath(held.root, found.absolute, body.path, 'read')
        const version = observedVersion(held.workspaceId, body.path, true)
        if (body.expectedVersion !== null && body.expectedVersion !== version)
          throw new Halt('revision_conflict', 'version does not match')
        const bytes = await slurp(found.absolute)
        const slice =
          body.range === null
            ? bytes
            : bytes.subarray(body.range.offset, body.range.offset + body.range.length)
        if (body.range !== null && body.range.offset + body.range.length > bytes.byteLength)
          throw new Halt('range_not_satisfiable', 'range exceeds the file')
        return admit('FilesReadResult', { bytesRef: await keep(slice, 'application/octet-stream'), version })
      })
    },
    write(request, context) {
      return guarded(context, async () => {
        live()
        rejectRemote()
        const body = demand('FilesWriteRequest', request)
        const held = leaseRoot(body.mountRef, context, true)
        const found = await walk(held.root, body.path, true)
        guardPath(held.root, found.absolute, body.path, 'write')
        if (found.exists && found.kind !== 'file') throw new Halt('invalid_request', 'path escapes the mount')
        const bytes = await recall(body.bytesRef)
        const digest = sha(bytes)
        const prior = jobs(options.desk).get(context.invocationId) ?? null
        const onDisk = found.exists ? sha(await slurp(found.absolute)) : null
        if (prior && prior.workspaceId === held.workspaceId && prior.path === body.path) {
          if (prior.digest !== digest) {
            throw new Halt(
              prior.phase === 'landed' ? 'idempotency_conflict' : 'effect_unknown',
              prior.phase === 'landed' ? 'invocation already wrote different bytes' : 'effect is unknown',
            )
          }
          if (prior.phase === 'landed' && prior.result) return demand('FilesWriteResult', prior.result)
          if (onDisk !== digest) throw new Halt('effect_unknown', 'effect is unknown')
          if (!prior.intent) throw new Halt('effect_unknown', 'effect is unknown')
          options.desk.append('version', `${held.workspaceId}\0${body.path}`, {
            version: prior.version,
            digest,
          })
          const result = written(body.path, context.invocationId, prior.intent, prior.version, digest)
          options.desk.append('landed', context.invocationId, {
            phase: 'landed',
            workspaceId: held.workspaceId,
            path: body.path,
            digest,
            version: prior.version,
            intent: prior.intent,
            result,
          } satisfies Job)
          return result
        }
        if (prior) throw new Halt('idempotency_conflict', 'invocation already wrote another path')
        const observed = observedVersion(held.workspaceId, body.path, found.exists)
        if (body.expectedVersion.kind === 'absent' && found.exists)
          throw new Halt('revision_conflict', 'version does not match')
        if (body.expectedVersion.kind === 'exact' && body.expectedVersion.revision !== observed)
          throw new Halt('revision_conflict', 'version does not match')
        const version = observed + 1
        const beforeBytes = found.exists ? await slurp(found.absolute) : new Uint8Array()
        const beforePin = await keep(beforeBytes, 'application/octet-stream')
        let checkpointId: string | null = null
        try {
          if (options.checkpoint)
            checkpointId = (await options.checkpoint.snapshot(found.absolute, context.invocationId)).id
        } catch {
          throw new Halt('blocked', 'checkpoint failed')
        }
        const intent: Intent = {
          before: found.exists ? 'present' : 'absent',
          beforeVersion: found.exists ? observed : null,
          beforeDigest: sha(beforeBytes),
          pinId: beforePin.pinId,
          checkpointId,
        }
        options.desk.append('intent', context.invocationId, {
          phase: 'intent',
          workspaceId: held.workspaceId,
          path: body.path,
          digest,
          version,
          intent,
          result: null,
        } satisfies Job)
        const partial = join(dirname(found.absolute), `.${randomUUID()}.partial`)
        try {
          const handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
          try {
            await handle.writeFile(bytes)
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(partial, found.absolute)
          const directory = await open(dirname(found.absolute), constants.O_RDONLY)
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        } catch (error) {
          await rm(partial, { force: true })
          throw error
        }
        if (options.stall === 'landed') throw new Halt('effect_unknown', 'effect is unknown')
        options.desk.append('version', `${held.workspaceId}\0${body.path}`, { version, digest })
        const result = written(body.path, context.invocationId, intent, version, digest)
        options.desk.append('landed', context.invocationId, {
          phase: 'landed',
          workspaceId: held.workspaceId,
          path: body.path,
          digest,
          version,
          intent,
          result,
        } satisfies Job)
        return result
      })
    },
    list(request, context) {
      return guarded(context, async () => {
        live()
        rejectRemote()
        const body = demand('FilesListRequest', request)
        if (body.limit < 1 || body.limit > 10_000) throw new Halt('invalid_request', 'list limit is invalid')
        const held = leaseRoot(body.mountRef, context, false)
        const found = await walk(held.root, body.path, false)
        if (!found.exists || found.kind !== 'directory') throw new Halt('not_found', 'path is absent')
        guardPath(held.root, found.absolute, body.path, 'list')
        const names = [...(await readdir(found.absolute))].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        const entries: Wire.FileEntry[] = []
        for (const name of names) {
          const rel = body.path.length === 0 || body.path === '.' ? name : `${body.path}/${name}`
          if (fence.blocks('workspace', rel, 'list')) continue
          const first = await lstat(join(found.absolute, name))
          const second = await lstat(join(found.absolute, name))
          if (first.isSymbolicLink() !== second.isSymbolicLink() || first.size !== second.size)
            throw new Halt('permission_denied', 'symlink escapes the mount')
          const kind = second.isSymbolicLink() ? 'symlink' : second.isDirectory() ? 'directory' : 'file'
          entries.push(
            admit('FileEntry', {
              path: rel,
              kind,
              bytes: kind === 'file' ? second.size : null,
              revision: observedVersion(held.workspaceId, rel, kind === 'file'),
            }),
          )
        }
        const start = body.cursor === null ? 0 : Number(body.cursor)
        if (!Number.isInteger(start) || start < 0 || String(start) !== (body.cursor ?? '0'))
          throw new Halt('invalid_request', 'list cursor is invalid')
        const page = entries.slice(start, start + body.limit)
        const next = start + body.limit < entries.length ? String(start + body.limit) : null
        return admit('FilesListResult', {
          items: page,
          snapshot: sha(Buffer.from(entries.map((entry) => entry.path).join('\n'))),
          nextCursor: next,
          complete: next === null,
        })
      })
    },
    stat(request, context) {
      return guarded(context, async () => {
        live()
        rejectRemote()
        const body = demand('FilesStatRequest', request)
        const held = leaseRoot(body.mountRef, context, false)
        const found = await walk(held.root, body.path, false)
        if (!found.exists) throw new Halt('not_found', 'path is absent')
        guardPath(held.root, found.absolute, body.path, 'stat')
        const info = await lstat(found.link ?? found.absolute)
        const kind = found.link
          ? 'symlink'
          : info.isFile()
            ? 'file'
            : info.isDirectory()
              ? 'directory'
              : 'other'
        return admit('FileStat', {
          kind,
          bytes: kind === 'file' || kind === 'symlink' ? info.size : 0,
          mtimeMs: info.mtimeMs,
          version: observedVersion(held.workspaceId, body.path, true),
        })
      })
    },
    verifyPolicy(request, context) {
      return guarded(context, async () => {
        live()
        rejectRemote()
        const snapshot = demand('FsPolicySnapshot', request)
        const bodyDigest = canonicalJsonDigest({
          compilerVersion: snapshot.compilerVersion,
          policyId: snapshot.policyId,
          roots: snapshot.roots,
          rules: snapshot.rules,
          scope: snapshot.scope,
        })
        if (snapshot.digest !== bodyDigest) throw new Halt('integrity', 'policy digest does not match')
        if (canonicalJsonDigest(context.scope) !== canonicalJsonDigest(snapshot.scope))
          throw new Halt('permission_denied', 'workspace is outside the caller scope')
        for (const [root, path] of FLOOR) {
          const present = snapshot.rules.some(
            (rule) => rule.root === root && rule.path === path && rule.effect === 'hard-deny',
          )
          if (!present) throw new Halt('invalid_request', 'hard deny is incomplete')
        }
        const workspaceRoot = snapshot.roots.find((item) => item.kind === 'workspace')
        if (!workspaceRoot) throw new Halt('invalid_request', 'hard deny is incomplete')
        const shot = fold(options.desk)
        const space = shot.spaces.get(workspaceRoot.mount.workspaceId)
        const lease = shot.leases
          .filter(
            (item) =>
              item.workspaceId === workspaceRoot.mount.workspaceId &&
              item.ownerId === context.principalRef &&
              !item.released,
          )
          .sort((left, right) => right.epoch - left.epoch)[0]
        if (!space || !lease) throw new Halt('revoked', 'mount lease is not live')
        let exists = true
        try {
          const info = await stat(space.root)
          if (!info.isDirectory()) throw new Halt('invalid_request', 'workspace root is not a directory')
        } catch (error) {
          if (!absent(error)) throw error
          exists = false
        }
        const directories: Record<RootKind, string> = {
          workspace: space.root,
          home: options.places.home,
          data: options.places.data,
        }
        const local = new Fence(snapshot.rules)
        const probes: Wire.FsEnforcementProof['probes'][number][] = []
        for (const [root, path] of FLOOR) {
          try {
            await stat(join(directories[root], path))
          } catch (error) {
            if (absent(error)) throw new Halt('integrity', 'hard deny path is absent')
            throw error
          }
          if (!local.blocks(root, path, 'read'))
            throw new Halt('invalid_request', 'hard deny is not enforced')
          probes.push({ root, path, decision: 'denied', evidenceCode: 'E_FS_DENIED' })
        }
        const leaseRef = admit('LeaseRef', {
          authorityId: options.authorityId,
          leaseId: lease.leaseId,
          epoch: lease.epoch,
          expiresAt: new Date(lease.expiresAt).toISOString(),
        })
        const unsigned = {
          policyDigest: snapshot.digest,
          provider: binding,
          authorityEpoch: lease.epoch,
          checkedAt: new Date(options.desk.now()).toISOString(),
          scope: snapshot.scope,
          workspaceRoot: {
            mount: {
              workspaceId: lease.workspaceId,
              mountId: lease.mountId,
              revision: space.revision,
              lease: leaseRef,
            },
            policyDecision: 'allow' as const,
            exists,
          },
          probes,
        }
        return admit('FsEnforcementProof', { ...unsigned, digest: canonicalJsonDigest(unsigned) })
      })
    },
    authorityFence(_request, context) {
      if (closed || options.desk.shut)
        return Promise.resolve({ ok: false, error: fault('blocked', 'service is closed') })
      if (context.signal.aborted)
        return Promise.resolve({ ok: false, error: fault('cancelled', 'call was cancelled') })
      return Promise.resolve({
        ok: false,
        error: fault('unsupported', 'authority transfer is not supported'),
      })
    },
    close() {
      closed = true
    },
  }
}
