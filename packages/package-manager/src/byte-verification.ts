import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay, setImmediate } from 'node:timers/promises'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { PackageError } from './errors.js'
import { canonical } from './integrity.js'
import { hashDirectory, hashDirectoryAsync } from './sources.js'
import {
  sameTreeIdentity,
  supportsTreeIdentity,
  type TreeIdentity,
  treeIdentity,
  treeIdentitySync,
} from './tree-identity.js'
import { treeVerificationError, treeVerificationFailure } from './tree-verification-error.js'

export type ByteIdentity = Readonly<{
  version: string
  integrity: string
  treeIntegrity?: string | undefined
  capabilityHash: string
  packageId?: string
}>
export type ByteFailure = Readonly<{
  directory: string
  identity: ByteIdentity
  binding: string
  lockBinding?: string
}>
export type PackageBootAdmission = Readonly<{
  binding: string
  trees: readonly Readonly<{ directory: string; identity: ByteIdentity }>[]
}>
type Observation = ByteFailure & { tree: TreeIdentity; verifiedAt: number; cost: number }
const owners = new AsyncLocalStorage<PackageByteVerification | undefined>()
const fullOnly = new AsyncLocalStorage<boolean>()
const issuedAdmissions = new WeakSet<PackageBootAdmission>()

/** Small live control files are read again, including trust stamps. This is never an auth cache. */
export function packageByteBinding(profileDir: string): string {
  const hash = createHash('sha256')
  for (const name of [
    'agnes-lock.json',
    '.agnes-runtime-snapshots.json',
    'plugin-capabilities.json',
    'package-sources.json',
  ]) {
    hash.update(name).update('\0')
    try {
      const file = join(profileDir, name),
        stat = lstatSync(file, { bigint: true })
      hash.update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'))
      hash.update(readFileSync(file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      hash.update('absent')
    }
  }
  return hash.digest('hex')
}
export function packageLockByteBinding(profileDir: string): string {
  try {
    const file = join(profileDir, 'agnes-lock.json'),
      stat = lstatSync(file, { bigint: true })
    return createHash('sha256')
      .update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'))
      .update(readFileSync(file))
      .digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
}
function fail(): never {
  throw new PackageError('E_LOCK_MISMATCH', 'package bytes are unavailable or changed during verification', {
    detail: { reason: 'tree-changed' },
  })
}
function identityBinding(identity: ByteIdentity): string {
  return canonical({
    version: identity.version,
    integrity: identity.integrity,
    treeIntegrity: identity.treeIntegrity,
    capabilityHash: identity.capabilityHash,
  })
}
function storedIdentity(identity: ByteIdentity): ByteIdentity {
  return Object.freeze({
    version: identity.version,
    integrity: identity.integrity,
    treeIntegrity: identity.treeIntegrity,
    capabilityHash: identity.capabilityHash,
    ...(identity.packageId ? { packageId: identity.packageId } : {}),
  })
}
function observationCost(key: string, identity: ByteIdentity, tree: TreeIdentity): number {
  return (
    (key.length + JSON.stringify(identity).length + JSON.stringify(tree.nodes).length) * 2 +
    tree.nodes.length * 128
  )
}
function inside(root: string, directory: string): boolean {
  const rel = relative(root, directory)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Executable-owned byte observations. No setters, persisted positives or trust decisions. A new
 * instance constructed by a client/plugin has no relationship to an existing owner instance. */
export class PackageByteVerification {
  readonly #records = new Map<string, Observation>()
  readonly #pending = new Map<string, Promise<string>>()
  readonly #active = new Set<Promise<string>>()
  readonly #notifications = new Set<Promise<void>>()
  readonly #sealed = new Set<string>()
  readonly #abort = new AbortController()
  readonly #timer: ReturnType<typeof globalThis.setInterval>
  #binding = ''
  #lockBinding = ''
  #epoch = 0
  #bytes = 0
  #wall: number
  #mono: number
  #background: Promise<void> | undefined
  #boot: PackageBootAdmission | undefined
  #closed = false
  #bootUsed = false
  #startupAdmission: PackageBootAdmission | undefined

  constructor(
    readonly options: Readonly<{
      profileDir: string
      roots: readonly string[]
      onMismatch?(failure: ByteFailure): void
      /** Executable-only: input validated by the private fork IPC receiver, never public JSON. */
      startupAdmission?: PackageBootAdmission
      now?: () => number
      wallNow?: () => number
      softMs?: number
      hardMs?: number
      maxRecords?: number
      maxBytes?: number
      quietMs?: number
    }>,
  ) {
    this.#startupAdmission = options.startupAdmission
    this.#wall = this.#wallNow()
    this.#mono = this.#now()
    this.#timer = globalThis.setInterval(() => {
      void this.recheck().catch(() => undefined)
    }, 60_000)
    this.#timer.unref()
  }
  #now() {
    return this.options.now?.() ?? performance.now()
  }
  #wallNow() {
    return this.options.wallNow?.() ?? Date.now()
  }
  #hard() {
    return this.options.hardMs ?? 30 * 60_000
  }
  #stableAge(tree: TreeIdentity): boolean {
    const quiet = this.options.quietMs ?? 1000
    return quiet === 0 || this.#wallNow() - tree.latestChangeMs >= quiet
  }
  run<T>(action: () => T): T {
    return fullOnly.getStore() ? action() : owners.run(this, action)
  }
  invalidate(): void {
    this.#boot = undefined
    this.#epoch++
    this.#records.clear()
    this.#pending.clear()
    this.#bytes = 0
  }
  #state(): string {
    const wall = this.#wallNow(),
      mono = this.#now()
    const dw = wall - this.#wall,
      dm = mono - this.#mono
    if (dw < 0 || dm < 0 || Math.abs(dw - dm) > 1000 || Math.max(dw, dm) > this.#hard()) {
      this.invalidate()
      this.#boot = undefined
    }
    this.#wall = wall
    this.#mono = mono
    this.#lockBinding = packageLockByteBinding(this.options.profileDir)
    const binding = packageByteBinding(this.options.profileDir)
    if (binding !== this.#binding) {
      this.invalidate()
      this.#sealed.clear()
      this.#binding = binding
    }
    return binding
  }
  #cacheKey(directory: string, identity: ByteIdentity): string {
    return canonical({ directory, identity: identityBinding(identity), binding: this.#binding })
  }
  #key(directory: string, identity: ByteIdentity): string | undefined {
    if (this.#closed || !identity.treeIntegrity) return undefined
    try {
      this.#state()
      if (this.#sealed.has(this.#cacheKey(resolve(directory), identity))) fail()
      const lexical = resolve(directory)
      const physicalRoots = this.options.roots.flatMap((root) => {
        try {
          return [nativeRealpathSync(root)]
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw error
        }
      })
      if (
        ![...this.options.roots.map((root) => resolve(root)), ...physicalRoots].some((root) =>
          inside(root, lexical),
        )
      )
        return undefined
      const stat = lstatSync(directory)
      if (stat.isSymbolicLink()) throw treeVerificationError('symlink')
      if (!stat.isDirectory()) throw treeVerificationError('not-directory')
      const actual = nativeRealpathSync(directory)
      if (!physicalRoots.some((root) => inside(root, actual))) throw treeVerificationError('path-escape')
      const key = this.#cacheKey(actual, identity)
      if (this.#sealed.has(key)) fail()
      return key
    } catch (error) {
      this.#failed(error, directory, identity)
      throw error
    }
  }
  #failed(
    error: unknown,
    directory: string,
    identity: ByteIdentity,
    key?: string,
    epoch = this.#epoch,
  ): void {
    if (this.#closed || epoch !== this.#epoch) return
    if (treeVerificationFailure(error) === 'integrity') this.#fault(key, directory, identity)
    else if (key) this.#drop(key)
    else this.invalidate()
  }
  #fault(key: string | undefined, directory: string, identity: ByteIdentity): void {
    // Retain both logical and physical refusal keys: resolving an illegal root itself may fail.
    // Different physical copies still have independent byte evidence.
    const logical = this.#cacheKey(resolve(directory), identity)
    if (this.#sealed.has(logical) || (key && this.#sealed.has(key))) return
    this.#sealed.add(logical)
    if (key) this.#sealed.add(key)
    try {
      this.#sealed.add(
        this.#cacheKey(join(nativeRealpathSync(dirname(directory)), basename(directory)), identity),
      )
    } catch {
      /* The logical key and any prior observation still fence an unavailable parent. */
    }
    for (const [observedKey, record] of this.#records)
      if (resolve(record.directory) === resolve(directory)) this.#sealed.add(observedKey)
    this.invalidate()
    // Notification cannot hold up the byte read, profile lock, or a publication read ticket.
    const failure = {
      directory,
      identity: storedIdentity(identity),
      binding: this.#binding,
      lockBinding: this.#lockBinding,
    }
    const notified = new Promise<void>((resolve) =>
      globalThis.setImmediate(() => {
        try {
          this.options.onMismatch?.(failure)
        } finally {
          resolve()
        }
      }),
    )
    this.#notifications.add(notified)
    void notified.finally(() => this.#notifications.delete(notified))
  }
  #save(key: string, value: Observation): void {
    const old = this.#records.get(key)
    if (old) this.#bytes -= old.cost
    this.#records.delete(key)
    this.#records.set(key, value)
    this.#bytes += value.cost
    while (
      this.#records.size > (this.options.maxRecords ?? 4096) ||
      this.#bytes > (this.options.maxBytes ?? 64 * 1024 * 1024)
    ) {
      const first = this.#records.entries().next().value
      if (!first) break
      this.#bytes -= first[1].cost
      this.#records.delete(first[0])
    }
  }
  #admitted(directory: string, identity: ByteIdentity): boolean {
    const boot = this.#boot
    return (
      boot?.binding === this.#binding &&
      boot.trees.some(
        (tree) =>
          tree.directory === nativeRealpathSync(directory) &&
          identityBinding(tree.identity) === identityBinding(identity),
      ) === true
    )
  }
  #touch(key: string): void {
    const record = this.#records.get(key)
    if (record) {
      this.#records.delete(key)
      this.#records.set(key, record)
    }
  }
  #drop(key: string): void {
    const value = this.#records.get(key)
    if (value) this.#bytes -= value.cost
    this.#records.delete(key)
  }
  readSync(directory: string, identity: ByteIdentity): string {
    const key = this.#key(directory, identity),
      epoch = this.#epoch
    try {
      return key === undefined
        ? hashDirectory(directory, { exclude: [] })
        : this.#readSync(directory, identity, key, epoch)
    } catch (error) {
      if (key !== undefined) this.#failed(error, directory, identity, key, epoch)
      throw error
    }
  }
  #readSync(directory: string, identity: ByteIdentity, key: string, epoch: number): string {
    let violation: unknown
    if (this.#admitted(directory, identity)) return identity.treeIntegrity!
    if (!supportsTreeIdentity(directory)) {
      const actual = hashDirectory(directory, { exclude: [] })
      if (this.#key(directory, identity) !== key || epoch !== this.#epoch) fail()
      if (actual !== identity.treeIntegrity) this.#fault(key, directory, identity)
      return actual
    }
    const prior = this.#records.get(key)
    if (prior && this.#now() - prior.verifiedAt < this.#hard()) {
      try {
        const current = treeIdentitySync(directory)
        if (current.cacheable && sameTreeIdentity(prior.tree, current)) {
          if (this.#key(directory, identity) !== key || epoch !== this.#epoch) fail()
          this.#touch(key)
          return identity.treeIntegrity!
        }
      } catch (error) {
        if (treeVerificationFailure(error) === 'unavailable') throw error
        if (treeVerificationFailure(error) === 'integrity') violation = error
      }
    }
    this.#drop(key)
    for (let attempt = 0; attempt < 2; attempt++) {
      let before: TreeIdentity | undefined
      try {
        before = treeIdentitySync(directory)
      } catch (error) {
        if (treeVerificationFailure(error) === 'unavailable') throw error
        if (treeVerificationFailure(error) === 'integrity') violation = error
      }
      const actual = hashDirectory(directory, { exclude: [] })
      if (this.#key(directory, identity) !== key || epoch !== this.#epoch) fail()
      if (violation) throw violation
      if (actual !== identity.treeIntegrity) {
        this.#fault(key, directory, identity)
        return actual
      }
      const after = treeIdentitySync(directory)
      if (this.#key(directory, identity) !== key || epoch !== this.#epoch) fail()
      if (before && sameTreeIdentity(before, after)) {
        if (after.cacheable && this.#stableAge(after) && this.#key(directory, identity) === key)
          this.#save(key, {
            directory,
            identity: storedIdentity(identity),
            binding: this.#binding,
            tree: after,
            verifiedAt: this.#now(),
            cost: observationCost(key, identity, after),
          })
        return actual
      }
    }
    return fail()
  }
  async read(directory: string, identity: ByteIdentity): Promise<string> {
    const attempt = (remaining: number): Promise<string> => {
      const key = this.#key(directory, identity)
      if (key === undefined) return hashDirectoryAsync(directory, { exclude: [] })
      if (this.#admitted(directory, identity)) return Promise.resolve(identity.treeIntegrity!)
      const prior = this.#pending.get(key)
      if (prior) return prior
      const epoch = this.#epoch
      const result = this.#read(directory, identity, key, epoch)
        .catch((error) => {
          // A full-only scope can invalidate an unrelated pending read before taking the profile
          // lock. Discard that success; only the same live binding may obtain a new proof. Joining
          // a newer pending read is safe, and an old finally must never delete that newer pending.
          if (
            treeVerificationFailure(error) === 'unstable' &&
            !this.#closed &&
            epoch !== this.#epoch &&
            !this.#sealed.has(key) &&
            this.#key(directory, identity) === key
          ) {
            if (remaining > 0) return attempt(remaining - 1)
            throw new PackageError(
              'E_LOCK_MISMATCH',
              'package verification was superseded by concurrent activity',
              {
                code: 'E_PACKAGE_BUSY',
                detail: { reason: 'busy' },
              },
            )
          }
          this.#failed(error, directory, identity, key, epoch)
          throw error
        })
        .finally(() => {
          if (this.#pending.get(key) === result) this.#pending.delete(key)
          this.#active.delete(result)
        })
      this.#pending.set(key, result)
      this.#active.add(result)
      return result
    }
    return attempt(2)
  }
  async #read(directory: string, identity: ByteIdentity, key: string, epoch: number): Promise<string> {
    if (!supportsTreeIdentity(directory)) {
      const actual = await hashDirectoryAsync(directory, { exclude: [], signal: this.#abort.signal })
      if (this.#key(directory, identity) !== key || epoch !== this.#epoch) return fail()
      if (actual !== identity.treeIntegrity) this.#fault(key, directory, identity)
      return actual
    }
    let violation: unknown
    const prior = this.#records.get(key)
    if (prior && this.#now() - prior.verifiedAt < this.#hard()) {
      try {
        const current = await treeIdentity(directory)
        if (current.cacheable && sameTreeIdentity(prior.tree, current)) {
          if (this.#key(directory, identity) !== key || epoch !== this.#epoch) fail()
          this.#touch(key)
          return identity.treeIntegrity!
        }
      } catch (error) {
        if (treeVerificationFailure(error) === 'unavailable') throw error
        if (treeVerificationFailure(error) === 'integrity') violation = error
      }
    }
    this.#drop(key)
    for (let attempt = 0; attempt < 2; attempt++) {
      let before: TreeIdentity | undefined
      try {
        before = await treeIdentity(directory)
      } catch (error) {
        if (treeVerificationFailure(error) === 'unavailable') throw error
        if (treeVerificationFailure(error) === 'integrity') violation = error
      }
      const actual = await hashDirectoryAsync(directory, { exclude: [], signal: this.#abort.signal })
      if (this.#key(directory, identity) !== key || epoch !== this.#epoch) return fail()
      if (violation) throw violation
      if (actual !== identity.treeIntegrity) {
        this.#fault(key, directory, identity)
        return actual
      }
      const after = await treeIdentity(directory)
      if (this.#key(directory, identity) !== key || epoch !== this.#epoch) return fail()
      if (before && sameTreeIdentity(before, after)) {
        if (after.cacheable && this.#stableAge(after))
          this.#save(key, {
            directory,
            identity: storedIdentity(identity),
            binding: this.#binding,
            tree: after,
            verifiedAt: this.#now(),
            cost: observationCost(key, identity, after),
          })
        return actual
      }
    }
    return fail()
  }
  /** A fresh check at spawn, not a transferable TTL or a worker success-report API. */
  async admission(): Promise<PackageBootAdmission> {
    this.#state()
    const records = [...this.#records.values()],
      epoch = this.#epoch
    for (const record of records)
      if ((await this.read(record.directory, record.identity)) !== record.identity.treeIntegrity) fail()
    const admission = Object.freeze({
      binding: this.#state(),
      trees: Object.freeze(
        (epoch === this.#epoch ? records : []).map(({ directory, identity }) =>
          Object.freeze({
            directory: nativeRealpathSync(directory),
            identity,
          }),
        ),
      ),
    })
    issuedAdmissions.add(admission)
    return admission
  }
  async boot<T>(admission: PackageBootAdmission, action: () => Promise<T>): Promise<T> {
    const issued = issuedAdmissions.delete(admission)
    const allowed = !this.#bootUsed && (admission === this.#startupAdmission || issued)
    this.#bootUsed = true
    this.#startupAdmission = undefined
    if (!allowed || admission.binding !== this.#state()) return this.run(action)
    this.#boot = Object.freeze({
      binding: admission.binding,
      trees: Object.freeze(
        admission.trees.map((tree) =>
          Object.freeze({ directory: tree.directory, identity: storedIdentity(tree.identity) }),
        ),
      ),
    })
    try {
      return await this.run(action)
    } finally {
      this.#boot = undefined
      this.invalidate()
    }
  }
  /** Idle scheduling calls the real hasher even when every identity field still matches. */
  recheck(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    if (this.#background) return this.#background
    this.#background = this.#recheck().finally(() => {
      this.#background = undefined
    })
    return this.#background
  }
  async #recheck(): Promise<void> {
    try {
      this.#state()
    } catch (error) {
      this.invalidate()
      throw error
    }
    const epoch = this.#epoch
    let nextRead = this.#now() - 62.5
    const onChunk = async (bytes: number) => {
      nextRead = Math.max(nextRead, this.#now() - 62.5) + (bytes / (16 * 1024 * 1024)) * 1000
      const wait = nextRead - this.#now()
      if (wait > 0) await delay(wait, undefined, { signal: this.#abort.signal })
      await setImmediate(undefined, { signal: this.#abort.signal })
    }
    for (const [key, record] of [...this.#records].sort((a, b) => a[1].verifiedAt - b[1].verifiedAt)) {
      if (this.#closed || epoch !== this.#epoch) return
      if (this.#now() - record.verifiedAt < (this.options.softMs ?? 15 * 60_000)) continue
      try {
        const before = await treeIdentity(record.directory)
        const actual = await hashDirectoryAsync(record.directory, {
          exclude: [],
          signal: this.#abort.signal,
          onChunk,
        })
        if (this.#key(record.directory, record.identity) !== key || epoch !== this.#epoch) return
        if (actual !== record.identity.treeIntegrity) {
          this.#fault(key, record.directory, record.identity)
          return
        }
        const after = await treeIdentity(record.directory)
        if (
          epoch === this.#epoch &&
          sameTreeIdentity(before, after) &&
          after.cacheable &&
          this.#stableAge(after)
        )
          this.#save(key, { ...record, tree: after, verifiedAt: this.#now() })
        else this.#drop(key)
      } catch (error) {
        this.#failed(error, record.directory, record.identity, key, epoch)
      }
    }
  }
  async close(): Promise<void> {
    this.#closed = true
    globalThis.clearInterval(this.#timer)
    this.#abort.abort()
    this.invalidate()
    await this.#background?.catch(() => undefined)
    await Promise.allSettled([...this.#active, ...this.#notifications])
  }
}

export function byteDirectoryDigest(directory: string, identity: ByteIdentity): string | undefined {
  return owners.getStore()?.readSync(directory, identity)
}
export function byteDirectoryDigestAsync(
  directory: string,
  identity: ByteIdentity,
): Promise<string> | undefined {
  return owners.getStore()?.read(directory, identity)
}
/** Writers/fresh/recovery never consume an earlier byte observation, even inside a read scope. */
export function withoutByteVerification<T>(action: () => T): T {
  const owner = owners.getStore()
  owner?.invalidate()
  try {
    const result = fullOnly.run(true, () => owners.run(undefined, action))
    if (result instanceof Promise) return result.finally(() => owner?.invalidate()) as T
    return result
  } finally {
    owner?.invalidate()
  }
}
