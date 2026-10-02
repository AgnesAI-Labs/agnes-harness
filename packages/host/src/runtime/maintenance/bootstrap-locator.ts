import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Outcome } from '@agnes/extension-api/runtime'
import type { DataRef, JsonValue } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync, renameWriteThroughSync } from '@agnes/system-node'
import { withConfigurationLockSync } from '../../configuration-lock.js'

export interface BootstrapLocator {
  readonly directoryId: string
  readonly providerLockRef: DataRef
  readonly endpointRef: string
  readonly epoch: number
  readonly revision: number
  readonly cutoverId: string
}

export interface MaintenanceCredential {
  readonly principalRef: string
  readonly directoryId: string
  readonly credentialDigest: string
}

export interface StageZeroView {
  readonly locator: BootstrapLocator
  readonly credential: MaintenanceCredential
}

export interface BootstrapAnchor {
  readonly directory: string
  read(): Outcome<StageZeroView>
  compareAndSwap(expectedRevision: number, next: BootstrapLocator): Outcome<BootstrapLocator>
  writeJournal(id: string, body: JsonValue): Outcome<{ readonly id: string }>
  readJournal(id: string): Outcome<JsonValue | null>
}

// Known local filesystem identities. Network and unknown filesystems fail closed.
const LOCAL_FILESYSTEMS = new Set([
  1, 4, 17, 26, 0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0x2fc12fc1,
])

export function filesystemSupportsLocalRename(directory: string): boolean {
  let probe = resolve(directory)
  try {
    while (!existsSync(probe)) {
      const parent = dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
    return LOCAL_FILESYSTEMS.has(statfsSync(probe).type)
  } catch {
    return false
  }
}

export function pathsAreSeparate(left: string, right: string): boolean {
  const first = physicalPath(left)
  const second = physicalPath(right)
  if (first === second) return false
  const forward = relative(first, second)
  const backward = relative(second, first)
  return (
    (forward === '..' || forward.startsWith(`..${sep}`) || isAbsolute(forward)) &&
    (backward === '..' || backward.startsWith(`..${sep}`) || isAbsolute(backward))
  )
}

function physicalPath(path: string): string {
  let parent = resolve(path)
  while (!existsSync(parent)) {
    const next = dirname(parent)
    if (next === parent) break
    parent = next
  }
  return resolve(realpathSync(parent), relative(parent, resolve(path)))
}

export function createBootstrapAnchor(
  directory: string,
  initial: { readonly locator: BootstrapLocator; readonly principalRef: string },
): Outcome<BootstrapAnchor> {
  const locator = checkedLocator(initial.locator)
  if (!locator.ok) return locator
  if (!isAbsolute(directory)) return fail('invalid_input', 'anchor_path')
  const credential = credentialFor(initial.principalRef, locator.value.directoryId)
  try {
    createPrivateDirectorySync(directory)
    createPrivateDirectorySync(resolve(directory, 'journals'))
  } catch {
    return fail('incompatible', 'anchor_unwritable')
  }
  const view = { locator: locator.value, credential }
  const wrote = publishView(directory, view)
  if (!wrote.ok) return wrote
  return { ok: true, value: openAnchor(directory) }
}

/** Reopens an anchor without rewriting the published locator. */
export function openBootstrapAnchor(directory: string): Outcome<BootstrapAnchor> {
  if (!isAbsolute(directory)) return fail('invalid_input', 'anchor_path')
  const current = readStageZero(directory)
  if (!current.ok) return current
  if (!current.value) return fail('incompatible', 'anchor_absent')
  return { ok: true, value: openAnchor(directory) }
}

/** Reads only the external anchor. A missing or damaged business tree is ignored. */
export function readStageZero(anchorDirectory: string): Outcome<StageZeroView | null> {
  const file = resolve(anchorDirectory, 'locator.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: null }
    return fail('incompatible', 'anchor_unreadable')
  }
  return parseView(text)
}

export function credentialFor(principalRef: string, directoryId: string): MaintenanceCredential {
  const body = { principalRef, directoryId }
  return { principalRef, directoryId, credentialDigest: canonicalJsonDigest(body) }
}

function openAnchor(directory: string): BootstrapAnchor {
  return {
    directory,
    read() {
      const current = readStageZero(directory)
      if (!current.ok) return current
      if (!current.value) return fail('incompatible', 'anchor_absent')
      return { ok: true as const, value: current.value }
    },
    compareAndSwap(expectedRevision, next) {
      try {
        return withConfigurationLockSync(resolve(directory, 'locator-lock.sqlite'), () =>
          swap(expectedRevision, next),
        )
      } catch {
        return fail('retryable', 'anchor_busy')
      }
    },
    writeJournal(id, body) {
      if (!validateRuntime('Id', id).ok) return fail('invalid_input', 'schema')
      const folder = resolve(directory, 'journals')
      const name = `${canonicalJsonDigest(id)}.json`
      const text = JSON.stringify(body)
      const committed = writeStable(folder, name, text)
      if (!committed.ok) return committed
      return { ok: true, value: { id } }
    },
    readJournal(id) {
      if (!validateRuntime('Id', id).ok) return fail('invalid_input', 'schema')
      const file = resolve(directory, 'journals', `${canonicalJsonDigest(id)}.json`)
      try {
        return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) as JsonValue }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: null }
        return fail('incompatible', 'anchor_unreadable')
      }
    },
  }

  function swap(expectedRevision: number, next: BootstrapLocator): Outcome<BootstrapLocator> {
    const current = readStageZero(directory)
    if (!current.ok) return current
    if (!current.value) return fail('incompatible', 'anchor_absent')
    const checked = checkedLocator(next)
    if (!checked.ok) return checked
    if (current.value.locator.revision !== expectedRevision) return fail('conflict', 'locator_revision')
    if (checked.value.revision !== expectedRevision + 1) return fail('invalid_input', 'locator_revision')
    if (checked.value.epoch !== current.value.locator.epoch + 1)
      return fail('invalid_input', 'epoch_not_increasing')
    if (checked.value.directoryId !== current.value.locator.directoryId)
      return fail('invalid_input', 'route_identity')
    const wrote = publishView(directory, { locator: checked.value, credential: current.value.credential })
    if (!wrote.ok) return wrote
    return { ok: true, value: checked.value }
  }
}

function publishView(directory: string, view: StageZeroView): Outcome<true> {
  return writeStable(directory, 'locator.json', JSON.stringify(view))
}

function writeStable(directory: string, name: string, text: string): Outcome<true> {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temp = resolve(directory, `.${name}.${randomUUID()}.tmp`)
  const final = resolve(directory, name)
  let descriptor: number | undefined
  try {
    descriptor = createPrivateFileSync(temp)
    writeFileSync(descriptor, text)
    fsyncSync(descriptor)
  } catch {
    return fail('retryable', 'durability_failed')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  try {
    renameWriteThroughSync(temp, final)
  } catch {
    return fail('retryable', 'durability_failed')
  }
  return { ok: true, value: true }
}

function parseView(text: string): Outcome<StageZeroView> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return fail('incompatible', 'anchor_corrupt')
  }
  if (!parsed || typeof parsed !== 'object') return fail('incompatible', 'anchor_corrupt')
  const record = parsed as { locator?: unknown; credential?: unknown }
  const locator = checkedLocator(record.locator)
  if (!locator.ok) return fail('incompatible', 'anchor_corrupt')
  const credential = record.credential
  if (!credential || typeof credential !== 'object') return fail('incompatible', 'anchor_corrupt')
  const fields = credential as MaintenanceCredential
  if (
    !validateRuntime('Id', fields.principalRef).ok ||
    !validateRuntime('Id', fields.directoryId).ok ||
    !validateRuntime('Digest', fields.credentialDigest).ok
  ) {
    return fail('incompatible', 'anchor_corrupt')
  }
  const expected = credentialFor(fields.principalRef, fields.directoryId)
  if (expected.credentialDigest !== fields.credentialDigest) return fail('incompatible', 'anchor_corrupt')
  if (fields.directoryId !== locator.value.directoryId) return fail('incompatible', 'anchor_corrupt')
  return { ok: true, value: { locator: locator.value, credential: fields } }
}

function checkedLocator(value: unknown): Outcome<BootstrapLocator> {
  if (!value || typeof value !== 'object') return fail('invalid_input', 'schema')
  const locator = value as BootstrapLocator
  if (
    !validateRuntime('Id', locator.directoryId).ok ||
    !validateRuntime('DataRef', locator.providerLockRef).ok ||
    !validateRuntime('Id', locator.endpointRef).ok ||
    !validateRuntime('UInt53', locator.epoch).ok ||
    !validateRuntime('UInt53', locator.revision).ok ||
    !validateRuntime('Id', locator.cutoverId).ok
  ) {
    return fail('invalid_input', 'schema')
  }
  if (locator.epoch < 1 || locator.revision < 1) return fail('invalid_input', 'epoch_not_increasing')
  return { ok: true, value: locator }
}

function fail(
  code: 'invalid_input' | 'conflict' | 'incompatible' | 'retryable',
  detailCode: string,
): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Authority anchor refused the request',
      retryAdvice: { kind: code === 'retryable' ? 'retry_same_action' : 'never' },
      diagnosticId: 'authority-anchor',
    },
  }
}

export function anchorFile(directory: string): string {
  return resolve(directory, 'locator.json')
}

export function journalDirectory(directory: string): string {
  return dirname(resolve(directory, 'journals', 'item'))
}
