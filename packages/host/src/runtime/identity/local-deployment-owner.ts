import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { boundedCanonicalJson, canonicalJsonDigest } from '@agnes/protocol/runtime'
import { readStageZero } from '../maintenance/bootstrap-locator.js'

type PathOwner = Readonly<{
  path: string
  device: number
  inode: number
  uid: number
  mode: number
}>
export type LocalDeploymentOwnerFacts = Readonly<{
  uid: number
  directoryId: string
  locatorRevision: number
  locatorEpoch: number
  principalRef: string
  sourceDigest: string
}>
export type LocalDeploymentOwner = Readonly<{
  facts: LocalDeploymentOwnerFacts
  /** Filesystem observations belong before the final issuer clock. */
  dynamicCheck(): void
  /** Fixed Host descriptors only; no filesystem, OS call, getter or clock. */
  staticCheck(): void
}>
const owners = new WeakMap<object, Readonly<{ database: DatabaseSync; readGeneration(): void }>>()
const nativePrepare = DatabaseSync.prototype.prepare
const nativeGet = StatementSync.prototype.get
const descriptorOf = Object.getOwnPropertyDescriptor
const originalUid = descriptorOf(process, 'getuid')
const originalEffectiveUid = descriptorOf(process, 'geteuid')
const apply = Reflect.apply
function fixedOwnerMethod(name: 'getuid' | 'geteuid', original: PropertyDescriptor | undefined): void {
  const actual = descriptorOf(process, name)
  if (
    !original ||
    !actual ||
    !('value' in original) ||
    !('value' in actual) ||
    typeof original.value !== 'function' ||
    actual.value !== original.value ||
    actual.writable !== original.writable ||
    actual.enumerable !== original.enumerable ||
    actual.configurable !== original.configurable
  )
    throw new Error('Original OS owner methods are unavailable or changed')
}
function fixedOwnerMethods(): void {
  fixedOwnerMethod('getuid', originalUid)
  fixedOwnerMethod('geteuid', originalEffectiveUid)
}
function digestObservation(value: unknown): string {
  const checked = boundedCanonicalJson(value, { maxBytes: 65536, maxDepth: 64, maxMembers: 10000 })
  if (!checked.ok) throw new Error('Local owner observations exceed their native proof limits')
  return canonicalJsonDigest(checked.value.json)
}

export function localDeploymentOwnerUsesDatabase(owner: unknown, database: DatabaseSync): boolean {
  const binding = typeof owner === 'object' && owner !== null ? owners.get(owner) : undefined
  if (!binding || binding.database !== database) return false
  try {
    binding.readGeneration()
    return true
  } catch {
    return false
  }
}

function ownerUid(): number {
  fixedOwnerMethods()
  if (!originalUid || !originalEffectiveUid) throw new Error('Local deployment OS owner is unavailable')
  const uid: unknown = apply(originalUid.value, process, [])
  const effective: unknown = apply(originalEffectiveUid.value, process, [])
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0 || effective !== uid)
    throw new Error('Local deployment OS owner does not match the effective process owner')
  return uid
}

function ownedPath(path: string, uid: number, privateObject: boolean): PathOwner {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    throw new Error('Local deployment path is not an original regular object')
  if (privateObject) {
    if (stat.uid !== uid || (stat.mode & 0o077) !== 0)
      throw new Error('Local deployment object is not private to the actual OS owner')
  } else {
    if (!stat.isDirectory()) throw new Error('Local deployment ancestor is not a directory')
    const sharedSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0
    if ((stat.uid !== 0 && stat.uid !== uid) || ((stat.mode & 0o022) !== 0 && !sharedSticky))
      throw new Error('Local deployment ancestor permits an untrusted path replacement')
  }
  return Object.freeze({ path, device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode })
}

/** Actual local owner observations only; this does not issue a C14 identity or a publication. */
export function captureLocalDeploymentOwner(
  input: Readonly<{
    database: DatabaseSync
    deploymentDirectory: string
  }>,
): LocalDeploymentOwner {
  if (!(input.database instanceof DatabaseSync)) throw new Error('Original native connection is required')
  const database = input.database
  const originalStatement: StatementSync = apply(nativePrepare, database, ['SELECT 1 AS native_generation'])
  const readGeneration = () => {
    const row = apply(nativeGet, originalStatement, [])
    if (row?.native_generation !== 1) throw new Error('Original native connection generation is unavailable')
  }
  readGeneration()
  const directory = input.deploymentDirectory
  if (!isAbsolute(directory) || realpathSync(directory) !== directory)
    throw new Error('Local deployment directory must be an original absolute path')
  const main = database
    .prepare('PRAGMA database_list')
    .all()
    .find((row) => row.name === 'main')
  if (!main || typeof main.file !== 'string' || !main.file || realpathSync(main.file) !== main.file)
    throw new Error('Local deployment needs the original persistent State file')
  const file = main.file
  const under = relative(directory, file)
  if (!under || under === '..' || under.startsWith(`..${sep}`) || isAbsolute(under))
    throw new Error('Original State file is outside the protected local deployment')
  const locatorFile = `${directory}${sep}locator.json`
  function observe() {
    readGeneration()
    const uid = ownerUid()
    const paths = [ownedPath(directory, uid, true), ownedPath(file, uid, true)]
    let parent = dirname(file)
    while (parent !== directory) {
      paths.push(ownedPath(parent, uid, true))
      parent = dirname(parent)
    }
    paths.push(ownedPath(locatorFile, uid, true))
    parent = dirname(directory)
    for (;;) {
      paths.push(ownedPath(parent, uid, false))
      const next = dirname(parent)
      if (next === parent) break
      parent = next
    }
    const view = readStageZero(directory)
    if (!view.ok || !view.value) throw new Error('Original deployment bootstrap is unavailable')
    return { uid, paths, view: view.value }
  }
  const observed = observe()
  const originalDigest = digestObservation(observed)
  const facts = Object.freeze({
    uid: observed.uid,
    directoryId: observed.view.locator.directoryId,
    locatorRevision: observed.view.locator.revision,
    locatorEpoch: observed.view.locator.epoch,
    principalRef: canonicalJsonDigest({
      directoryId: observed.view.locator.directoryId,
      uid: observed.uid,
    }),
    sourceDigest: originalDigest,
  })
  const owner = Object.freeze({
    facts,
    dynamicCheck() {
      if (digestObservation(observe()) !== originalDigest)
        throw new Error('Original local deployment owner observations changed')
    },
    staticCheck() {
      fixedOwnerMethods()
      readGeneration()
    },
  })
  owners.set(owner, Object.freeze({ database, readGeneration }))
  return owner
}
