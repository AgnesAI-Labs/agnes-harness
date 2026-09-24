import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CheckpointSeam } from '@agnes/core'
import type { HostFs, SeamFactory, SeamInitContext } from '../../../src/seam-init.js'
import { type Captured, ShadowGit } from './shadow-git.js'

const DAY = 24 * 60 * 60 * 1000
const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
// biome-ignore format: error construction remains a single expression.
const error = (code: string, message: string, details: Record<string, unknown> = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...details })
// biome-ignore format: preserve hostile error objects without reading inherited getters.
const codeOf = (value: unknown): unknown => typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, 'code')?.value : undefined
const isMissing = (value: unknown): boolean => codeOf(value) === 'ENOENT'
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// biome-ignore format: the three deterministic test seams form one dependency contract.
export type CheckpointDeps = { now(): number; nextId(): string; workspaceHash(value: string): string }
// biome-ignore format: production uses only the required cryptographic/time primitives.
const defaults: CheckpointDeps = { now: Date.now, nextId: () => randomBytes(16).toString('hex'), workspaceHash: (value) => sha256(value) }

type WorkspaceSerial = Readonly<{
  run<T>(root: string, operation: () => Promise<T>): Promise<T>
}>

function workspaceSerial(): WorkspaceSerial {
  const tails = new Map<string, Promise<void>>()
  return Object.freeze({
    run<T>(root: string, operation: () => Promise<T>): Promise<T> {
      const previous = tails.get(root) ?? Promise.resolve()
      const current = previous.then(operation, operation)
      const tail = current.then(
        () => undefined,
        () => undefined,
      )
      tails.set(root, tail)
      void tail.finally(() => {
        if (tails.get(root) === tail) tails.delete(root)
      })
      return current
    },
  })
}

async function canonicalMissing(fs: HostFs, root: string, input: string): Promise<string> {
  const absolute = isAbsolute(input) ? input : resolve(root, input)
  let probe = dirname(absolute)
  const suffix: string[] = [absolute.slice(probe.length + (probe.endsWith('/') ? 0 : 1))]
  for (;;) {
    try {
      const base = await fs.realpath(probe)
      const target = resolve(base, ...suffix.reverse())
      if (!within(root, target)) throw error('E_FS_DENIED', input)
      return target
    } catch (cause) {
      if (!isMissing(cause)) throw cause
      const parent = dirname(probe)
      if (parent === probe) throw cause
      suffix.push(probe.slice(parent.length + (parent.endsWith('/') ? 0 : 1)))
      probe = parent
    }
  }
}

async function capture(fs: HostFs, root: string, input: string, maxBytes: number): Promise<Captured> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let before: Awaited<ReturnType<HostFs['stat']>>
    try {
      before = await fs.stat(input)
    } catch (cause) {
      if (!isMissing(cause)) throw cause
      const first = await canonicalMissing(fs, root, input)
      try {
        await fs.stat(input)
      } catch (second) {
        if (!isMissing(second)) throw second
        const last = await canonicalMissing(fs, root, input)
        if (first === last) return { rel: relative(root, first).split('\\').join('/'), state: 'absent' }
        continue
      }
      continue
    }
    if (before.kind !== 'file') throw error('E_CHECKPOINT_UNSUPPORTED', `${input} is ${before.kind}`)
    const real = await fs.realpath(input)
    if (!within(root, real)) throw error('E_FS_DENIED', input)
    const value = await fs.read(real)
    let after: Awaited<ReturnType<HostFs['stat']>>
    try {
      after = await fs.stat(input)
    } catch (cause) {
      if (isMissing(cause)) continue
      throw cause
    }
    const final = await fs.realpath(input)
    if (after.kind !== 'file') throw error('E_CHECKPOINT_UNSUPPORTED', `${input} is ${after.kind}`)
    // biome-ignore format: one stable-read invariant.
    if (real !== final || before.size !== after.size || before.mtimeMs !== after.mtimeMs || value.length !== after.size)
      continue
    const digest = sha256(value)
    if (value.length > maxBytes || value.subarray(0, 8192).includes(0))
      throw error('E_CHECKPOINT_UNRESTORABLE', input, { size: value.length, sha256: digest })
    // biome-ignore format: this mirrors the compact Captured schema.
    return { rel: relative(root, real).split('\\').join('/'), state: 'file', bytes: value, size: value.length, sha256: digest }
  }
  throw error('E_CHECKPOINT_RACE', input)
}

function config(ctx: SeamInitContext): { keep: number; maxBytes: number } {
  const raw = ctx.profile.preset.checkpoint
  // biome-ignore format: one guarded preset lookup.
  const checkpoint = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const integer = (value: unknown, fallback: number) =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback
  // biome-ignore format: the two checkpoint limits are one preset projection.
  return { keep: integer(checkpoint.keep, 200), maxBytes: integer(checkpoint.max_file_bytes, 10 * 1024 * 1024) }
}

// biome-ignore format: the public constructor signature is kept on one line for the package ratchet.
async function createBoundFsCheckpoint(
  ctx: SeamInitContext,
  fs: HostFs,
  workspaceRoot: string,
  deps: CheckpointDeps,
  serials: WorkspaceSerial,
): Promise<CheckpointSeam> {
  const root = await fs.realpath('.')
  const profileRoot = await fs.realpath(workspaceRoot)
  if (root !== profileRoot) throw error('E_CHECKPOINT_WORKSPACE', 'filesystem fence and profile root differ')
  const workspaceHash = deps.workspaceHash(root)
  if (!/^[0-9a-f]{64}$/.test(workspaceHash)) throw error('E_CHECKPOINT_IDENTITY', 'workspace hash is invalid')
  const shadow = new ShadowGit(ctx.adapters.dataFs, `checkpoints/${workspaceHash.slice(0, 16)}`)
  const serial = <T>(operation: () => Promise<T>): Promise<T> => serials.run(root, operation)
  await serial(() => shadow.init({ workspaceHash }))
  const { keep, maxBytes } = config(ctx)
  return {
    snapshot: (paths, stepId) =>
      serial(async () => {
        const dedup = new Map<string, Captured>()
        for (const path of paths) {
          const item = await capture(fs, root, path, maxBytes)
          dedup.set(item.rel, item)
        }
        const id = deps.nextId()
        const createdAt = deps.now()
        await shadow.create({ id, stepId, createdAt, files: [...dedup.values()] })
        await shadow.gc({ keep, now: createdAt, maxAgeMs: 7 * DAY })
        return { id }
      }),
    rewind: (id) =>
      serial(async () => {
        const checkpoint = await shadow.read(id)
        const preflight: Array<{ path: string; exists: boolean; bytes?: Uint8Array }> = []
        for (const entry of checkpoint.manifest.entries) {
          const path = join(root, ...entry.rel.split('/'))
          let exists = true
          try {
            const stat = await fs.stat(path)
            if (stat.kind !== 'file' || (await fs.realpath(path)) !== path)
              throw error('E_CHECKPOINT_PATH_CHANGED', entry.rel)
          } catch (cause) {
            if (!isMissing(cause)) throw cause
            exists = false
            if ((await canonicalMissing(fs, root, path)) !== path)
              throw error('E_CHECKPOINT_PATH_CHANGED', entry.rel)
          }
          const bytes = checkpoint.files.get(entry.rel)
          preflight.push(bytes ? { path, exists, bytes } : { path, exists })
        }
        const applied: string[] = []
        try {
          for (const item of preflight) {
            if (item.bytes) await fs.write(item.path, item.bytes)
            else if (item.exists) await fs.rm(item.path)
            applied.push(relative(root, item.path).split('\\').join('/'))
          }
        } catch (cause) {
          if (cause instanceof Error) Object.assign(cause, { applied })
          throw cause
        }
      }),
    list: () => serial(async () => (await shadow.list()).map(({ id, stepId }) => ({ id, stepId }))),
  }
}

// biome-ignore format: the public constructor signature is kept on one line for the package ratchet.
export async function createFsCheckpoint(ctx: SeamInitContext, deps: CheckpointDeps = defaults): Promise<CheckpointSeam> {
  const serials = workspaceSerial()
  const fitted = await createBoundFsCheckpoint(ctx, ctx.adapters.fs, ctx.profile.workspaceRoot, deps, serials)
  return Object.assign(fitted, {
    forWorkspace: (workspace: Readonly<{ root: string; fs: HostFs }>) =>
      createBoundFsCheckpoint(ctx, workspace.fs, workspace.root, deps, serials),
  })
}

export const fsCheckpoint: SeamFactory<CheckpointSeam> = (ctx) => createFsCheckpoint(ctx)
