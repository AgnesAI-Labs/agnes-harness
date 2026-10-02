import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeErrorDetails,
  type RuntimeWireTypes,
  validateRuntime,
} from '@agnes/protocol/runtime'

export const REFERENCE_WORKSPACE_CONTRACT = 'agh.workspace'
export const REFERENCE_WORKSPACE_PROVIDER_ID = 'agh.reference/workspace'

type Detail = keyof typeof RuntimeErrorDetails

export class Halt extends Error {
  readonly detail: Detail
  constructor(detail: Detail, message: string) {
    super(message)
    this.detail = detail
  }
}

export function fault(detail: Detail, message: string): Wire.RuntimeError {
  const retryAdvice =
    detail === 'effect_unknown'
      ? { kind: 'reconcile' as const, ownerRef: { kind: 'reconciliation' as const, id: 'workspace-files' } }
      : { kind: 'never' as const }
  return {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message,
    retryAdvice,
    diagnosticId: 'workspace-files',
  }
}

export function admit<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const verdict = validateRuntime(name, value)
  if (!verdict.ok) throw new Halt('internal_error', `${name} failed its own schema`)
  return verdict.value
}

export function demand<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const verdict = validateRuntime(name, value)
  if (!verdict.ok) throw new Halt('invalid_request', `${name} does not match its schema`)
  return verdict.value
}

type Note = { n: number; kind: string; key: string; body: unknown }

export type ReferenceDesk = {
  readonly directory: string
  now(): number
  append(kind: string, key: string, body: unknown): void
  notes(): readonly Note[]
  close(): void
  readonly shut: boolean
}

export function openReferenceDesk(directory: string, now: () => number = () => Date.now()): ReferenceDesk {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'ledger.jsonl')
  if (!existsSync(file)) {
    const created = openSync(file, 'w')
    closeSync(created)
    const parent = openSync(directory, 'r')
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
  }
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
  const flag = { shut: false }
  const desk: ReferenceDesk = {
    directory,
    now,
    get shut() {
      return flag.shut
    },
    append(kind, key, body) {
      if (flag.shut) throw new Halt('blocked', 'service is closed')
      const note: Note = { n: lines.length + 1, kind, key, body }
      const fd = openSync(file, 'a')
      try {
        writeSync(fd, `${JSON.stringify(note)}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      lines.push(JSON.stringify(note))
    },
    notes() {
      return lines.map((line) => JSON.parse(line) as Note)
    },
    close() {
      flag.shut = true
    },
  }
  return desk
}

type Space = { root: string; tenant: string; revision: number; resource: string }
type Held = {
  leaseId: string
  workspaceId: string
  mode: 'read' | 'write'
  epoch: number
  ownerId: string
  generation: number
  expiresAt: number
  mountId: string
  invocationId: string
  released: boolean
}

export type Fold = {
  spaces: Map<string, Space>
  byResource: Map<string, string>
  leases: Held[]
  epochs: Map<string, number>
}

export function fold(desk: ReferenceDesk): Fold {
  const spaces = new Map<string, Space>()
  const byResource = new Map<string, string>()
  const leases: Held[] = []
  const epochs = new Map<string, number>()
  const released = new Set<string>()
  for (const note of desk.notes()) {
    if (note.kind === 'bind') {
      const space = note.body as Space
      spaces.set(note.key, space)
      byResource.set(space.resource, note.key)
    } else if (note.kind === 'epoch') {
      epochs.set(note.key, note.body as number)
    } else if (note.kind === 'lease') {
      leases.push({ ...(note.body as Held) })
    } else if (note.kind === 'release') {
      released.add(note.key)
    }
  }
  const now = desk.now()
  for (const lease of leases) {
    if (released.has(lease.leaseId) || lease.expiresAt <= now) lease.released = true
  }
  return { spaces, byResource, leases, epochs }
}

export type DirectoryRead = {
  read(request: Wire.AuthorityDirectoryReadRequest): Promise<Outcome<Wire.AuthorityDirectoryReadResult>>
}

export type ReferenceWorkspace = {
  readonly binding: Wire.BindingRef
  readonly providerDigest: string
  readonly desk: ReferenceDesk
  readonly generation: number
  bind(workspaceId: string, root: string): Promise<Outcome<{ revision: number; canonicalRoot: string }>>
  acquire(request: unknown, context: CallContext): Promise<Outcome<Wire.WorkspaceAcquireResult>>
  release(request: unknown, context: CallContext): Promise<Outcome<Wire.WorkspaceReleaseResult>>
  authorityFence(request: unknown, context: CallContext): Promise<Outcome<never>>
  close(): void
}

function iso(ms: number): Wire.Timestamp {
  return new Date(ms).toISOString()
}

function workspaceOf(scope: Wire.ScopeRef): string | undefined {
  if (scope.kind === 'installation' || scope.kind === 'runtime') return undefined
  return scope.workspaceId
}

async function caught<T>(context: CallContext, body: () => Promise<T>): Promise<Outcome<T>> {
  if (context.signal.aborted) return { ok: false, error: fault('cancelled', 'call was cancelled') }
  try {
    return { ok: true, value: await body() }
  } catch (error) {
    if (error instanceof Halt) return { ok: false, error: fault(error.detail, error.message) }
    throw error
  }
}

function mountFor(authorityId: string, lease: Held, revision: number): Wire.WorkspaceAcquireResult {
  const leaseRef = admit('LeaseRef', {
    authorityId,
    leaseId: lease.leaseId,
    epoch: lease.epoch,
    expiresAt: iso(lease.expiresAt),
  })
  return admit('WorkspaceAcquireResult', {
    mountRef: { workspaceId: lease.workspaceId, mountId: lease.mountId, revision, lease: leaseRef },
    revision,
    leaseRef,
  })
}

export function createReferenceWorkspace(options: {
  desk: ReferenceDesk
  authorityId: Wire.Id
  tenantId: Wire.Id
  providerId?: Wire.Id
  generation?: number
  leaseMs?: number
  directoryRead?: DirectoryRead
  remote?: boolean
}): ReferenceWorkspace {
  const providerId = options.providerId ?? REFERENCE_WORKSPACE_PROVIDER_ID
  const generation = options.generation ?? 1
  const leaseMs = options.leaseMs ?? 60_000
  let closed = false
  const binding = admit('BindingRef', {
    bindingId: `${providerId}/binding`,
    contract: REFERENCE_WORKSPACE_CONTRACT,
    logicalName: 'workspace',
    providerId,
  })
  const providerDigest = canonicalJsonDigest({
    contract: REFERENCE_WORKSPACE_CONTRACT,
    providerId,
    recipe: 'jsonl-lease',
  })
  const live = () => {
    if (closed || options.desk.shut) throw new Halt('blocked', 'service is closed')
  }
  return {
    binding,
    providerDigest,
    desk: options.desk,
    generation,
    async bind(workspaceId, root) {
      try {
        live()
        let info: Awaited<ReturnType<typeof stat>>
        try {
          info = await stat(root)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new Halt('not_found', 'workspace root is not a directory')
          throw error
        }
        if (!info.isDirectory()) throw new Halt('invalid_request', 'workspace root is not a directory')
        const canonicalRoot = await realpath(root)
        const shot = fold(options.desk)
        const owner = shot.byResource.get(canonicalRoot)
        if (owner !== undefined && owner !== workspaceId)
          throw new Halt('revision_conflict', 'path already belongs to a workspace')
        const existing = shot.spaces.get(workspaceId)
        if (existing && existing.resource !== canonicalRoot)
          throw new Halt('revision_conflict', 'version does not match')
        if (existing && existing.tenant !== options.tenantId)
          throw new Halt('permission_denied', 'workspace is outside the caller scope')
        if (existing)
          return { ok: true, value: { revision: existing.revision, canonicalRoot: existing.root } }
        options.desk.append('bind', workspaceId, {
          root: canonicalRoot,
          tenant: options.tenantId,
          revision: 1,
          resource: canonicalRoot,
        })
        options.desk.append('epoch', workspaceId, 0)
        return { ok: true, value: { revision: 1, canonicalRoot } }
      } catch (error) {
        if (error instanceof Halt) return { ok: false, error: fault(error.detail, error.message) }
        throw error
      }
    },
    acquire(request, context) {
      return caught(context, async () => {
        live()
        if (options.remote) throw new Halt('unsupported', 'remote workspace transport is not supported')
        const body = demand('WorkspaceAcquireRequest', request)
        if (workspaceOf(context.scope) !== body.workspaceId)
          throw new Halt('permission_denied', 'workspace is outside the caller scope')
        if (options.directoryRead) {
          const looked = await options.directoryRead.read({
            kind: 'authority',
            logicalAuthorityId: body.workspaceId,
          })
          if (!looked.ok) {
            if (looked.error.detailCode !== 'not_found')
              throw new Halt('permission_denied', 'authority location does not match the workspace')
          } else if (
            looked.value.kind !== 'authority' ||
            looked.value.route.locationRef !== body.workspaceId
          ) {
            throw new Halt('permission_denied', 'authority location does not match the workspace')
          }
        }
        const shot = fold(options.desk)
        const space = shot.spaces.get(body.workspaceId)
        if (!space) throw new Halt('not_found', 'workspace is not bound')
        if (space.tenant !== options.tenantId)
          throw new Halt('permission_denied', 'workspace is outside the caller scope')
        if (body.expectedRevision !== null && body.expectedRevision !== space.revision)
          throw new Halt('revision_conflict', 'version does not match')
        const prior = shot.leases.find(
          (lease) => lease.workspaceId === body.workspaceId && lease.invocationId === context.invocationId,
        )
        if (prior) {
          if (prior.ownerId !== context.principalRef || prior.mode !== body.mode)
            throw new Halt('idempotency_conflict', 'invocation already holds a different lease')
          return mountFor(options.authorityId, prior, space.revision)
        }
        const active = shot.leases.filter(
          (lease) => lease.workspaceId === body.workspaceId && !lease.released,
        )
        if (body.mode === 'write' && active.length > 0)
          throw new Halt('revision_conflict', 'write lease is held')
        if (active.some((lease) => lease.mode === 'write'))
          throw new Halt('revision_conflict', 'write lease is held')
        const epoch = (shot.epochs.get(body.workspaceId) ?? 0) + 1
        const lease: Held = {
          leaseId: randomUUID(),
          workspaceId: body.workspaceId,
          mode: body.mode,
          epoch,
          ownerId: context.principalRef,
          generation,
          expiresAt: options.desk.now() + leaseMs,
          mountId: randomUUID(),
          invocationId: context.invocationId,
          released: false,
        }
        options.desk.append('epoch', body.workspaceId, epoch)
        options.desk.append('lease', lease.leaseId, lease)
        return mountFor(options.authorityId, lease, space.revision)
      })
    },
    release(request, context) {
      return caught(context, async () => {
        live()
        if (options.remote) throw new Halt('unsupported', 'remote workspace transport is not supported')
        const body = demand('WorkspaceReleaseRequest', request)
        const shot = fold(options.desk)
        const lease = shot.leases.find((item) => item.leaseId === body.leaseRef.leaseId)
        if (!lease) throw new Halt('not_found', 'mount lease is not live')
        if (lease.ownerId !== context.principalRef || lease.generation !== generation)
          throw new Halt('permission_denied', 'mount lease is not live')
        if (lease.epoch !== body.leaseRef.epoch) throw new Halt('revision_conflict', 'version does not match')
        if (!lease.released) options.desk.append('release', lease.leaseId, true)
        return admit('WorkspaceReleaseResult', { released: true })
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
