import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { SEAM_KINDS } from '@agnes/extension-api/seams'
import { decodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import type {
  GenerationSeams,
  PinnedSeam,
  PluginGenerationSnapshot,
  SessionGenerationPin,
} from './runtime-snapshots-generations.js'

/**
 * Durable generation metadata is untrusted bytes until it has been decoded here: JSON.parse alone
 * proves nothing about shape. Every storage-shape failure is one `E_GENERATION_INTEGRITY` naming
 * the file, so callers can report a located corruption instead of a stray TypeError. A record written
 * by a newer AGH is a different refusal (`*_NEWER`) and is never reported as damage.
 */
export class DurableStateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly file?: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'DurableStateError'
  }
}

export const GENERATION_ID_PATTERN = /^[a-f0-9-]{36}$/
const SHA256_HEX = /^[a-f0-9]{64}$/

export const corrupt = (file: string, reason: string): DurableStateError =>
  new DurableStateError('E_GENERATION_INTEGRITY', `${basename(file)}: ${reason}`, file)

export function parseRecord(bytes: string, file: string): unknown {
  try {
    return JSON.parse(bytes)
  } catch {
    throw corrupt(file, 'not valid JSON')
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export const sessionPinFileName = (sessionKey: string): string =>
  `${createHash('sha256').update(sessionKey).digest('hex')}.json`

function decodePinnedSeams(value: unknown, file: string): readonly PinnedSeam[] {
  if (!Array.isArray(value)) throw corrupt(file, 'seams must be an array')
  const kinds = new Set<string>()
  return value.map((entry, index) => {
    const seam = record(entry)
    if (
      !seam ||
      !text(seam.kind) ||
      !text(seam.provider) ||
      typeof seam.version !== 'string' ||
      !text(seam.sourcePackage) ||
      !text(seam.integrity)
    )
      throw corrupt(file, `seams[${index}] is not a pinned seam`)
    if (kinds.has(seam.kind)) throw corrupt(file, `seams[${index}] repeats kind ${seam.kind}`)
    kinds.add(seam.kind)
    return {
      kind: seam.kind,
      provider: seam.provider,
      version: seam.version,
      sourcePackage: seam.sourcePackage,
      integrity: seam.integrity,
    }
  })
}

/**
 * A session pin. A pin of a newer format is decoded only as far as the fields every format shares
 * (key, generation), which is enough to keep its generation alive; `allowNewer` false refuses it.
 */
export function decodeSessionPin(
  value: unknown,
  file: string,
  options: { allowNewer: boolean; currentFormat: number },
): SessionGenerationPin {
  const pin = record(value)
  if (!pin) throw corrupt(file, 'session pin is not an object')
  const { sessionKey, generationId, formatVersion } = pin
  if (!text(sessionKey)) throw corrupt(file, 'session pin has no sessionKey')
  if (!text(generationId) || !GENERATION_ID_PATTERN.test(generationId))
    throw corrupt(file, 'session pin has no valid generationId')
  if (basename(file) !== sessionPinFileName(sessionKey))
    throw corrupt(file, 'file name does not match the digest of its sessionKey')
  if (!Number.isSafeInteger(formatVersion) || (formatVersion as number) < 1)
    throw corrupt(file, 'session pin has no valid formatVersion')
  if ((formatVersion as number) > options.currentFormat) {
    if (!options.allowNewer)
      throw new DurableStateError(
        'E_GENERATION_PIN_NEWER',
        `session pin was written by a newer AGH (pin format ${formatVersion})`,
        file,
      )
    return { formatVersion: formatVersion as number, sessionKey, generationId }
  }
  const loop = record(pin.loop)
  if (pin.loop !== undefined && !(loop && text(loop.id) && text(loop.version)))
    throw corrupt(file, 'loop must carry an id and a version')
  if (
    pin.resourcesDigest !== undefined &&
    !(text(pin.resourcesDigest) && SHA256_HEX.test(pin.resourcesDigest))
  )
    throw corrupt(file, 'resourcesDigest is not a sha256 digest')
  return {
    formatVersion: formatVersion as number,
    sessionKey,
    generationId,
    seams: decodePinnedSeams(pin.seams, file),
    ...(loop ? { loop: { id: loop.id as string, version: loop.version as string } } : {}),
    ...(pin.resourcesDigest ? { resourcesDigest: pin.resourcesDigest as string } : {}),
  }
}

/** A version-3 snapshot must select every seam kind; a partial record cannot rebuild a container. */
export function decodeGenerationSeams(value: unknown, file: string): GenerationSeams {
  const seams = record(value)
  const selections = record(seams?.selections)
  if (!seams || seams.formatVersion !== 1 || !selections) throw corrupt(file, 'seams record is malformed')
  for (const kind of SEAM_KINDS) {
    const selection = record(selections[kind])
    if (
      !selection ||
      !text(selection.provider) ||
      (selection.version !== undefined && typeof selection.version !== 'string')
    )
      throw corrupt(file, `seam selection ${kind} is missing or malformed`)
  }
  return value as GenerationSeams
}

/** The generation record with every array element checked; hashes of the archive are verified by the caller. */
export function decodeGenerationRecord(
  value: unknown,
  id: string,
  file: string,
  currentVersion: number,
): PluginGenerationSnapshot {
  const generation = record(value)
  if (!generation) throw corrupt(file, 'generation record is not an object')
  const { version } = generation
  if (typeof version === 'number' && version > currentVersion)
    throw new DurableStateError(
      'E_GENERATION_SNAPSHOT_NEWER',
      `generation ${id} was written by a newer AGH (snapshot format ${version})`,
      file,
    )
  if (generation.id !== id) throw corrupt(file, 'record id does not match its directory')
  if (version !== undefined && ![1, 2, 3].includes(version as number))
    throw corrupt(file, 'unknown snapshot format version')
  if (version === 2 && !(text(generation.resourcesDigest) && SHA256_HEX.test(generation.resourcesDigest)))
    throw corrupt(file, 'resourcesDigest is not a sha256 digest')
  if (
    generation.resourcesDigest !== undefined &&
    !(text(generation.resourcesDigest) && SHA256_HEX.test(generation.resourcesDigest))
  )
    throw corrupt(file, 'resourcesDigest is not a sha256 digest')
  if (typeof generation.compatibility !== 'string') throw corrupt(file, 'compatibility is missing')
  if (!Array.isArray(generation.packages)) throw corrupt(file, 'packages must be an array')
  generation.packages.forEach((pkg, index) => {
    const row = record(pkg)
    if (!row || typeof row.id !== 'string' || typeof row.version !== 'string')
      throw corrupt(file, `packages[${index}] is not a package reference`)
  })
  if (!Array.isArray(generation.sources)) throw corrupt(file, 'sources must be an array')
  generation.sources.forEach((entry, index) => {
    const source = record(entry)
    const snapshot = record(source?.snapshot)
    if (
      !source ||
      source.trusted !== true ||
      !snapshot ||
      snapshot.directory !== String(index) ||
      !text(snapshot.treeIntegrity) ||
      !text(snapshot.packageId) ||
      !text(snapshot.version) ||
      !text(snapshot.snapshotId)
    )
      throw corrupt(file, `sources[${index}] is not a trusted package snapshot`)
  })
  const seams = version === 3 ? decodeGenerationSeams(generation.seams, file) : undefined
  try {
    decodeRuntimeTargetArtifact(generation.artifact as never)
  } catch (cause) {
    throw Object.assign(corrupt(file, 'artifact does not decode'), { cause })
  }
  return { ...(generation as unknown as PluginGenerationSnapshot), ...(seams ? { seams } : {}) }
}

export function decodeHeadRecord(value: unknown, compositionKey: string | undefined, file: string): string {
  const head = record(value)
  if (
    !head ||
    !text(head.compositionKey) ||
    !text(head.generationId) ||
    !GENERATION_ID_PATTERN.test(head.generationId)
  )
    throw corrupt(file, 'head record is malformed')
  if (compositionKey !== undefined && head.compositionKey !== compositionKey)
    throw corrupt(file, 'head record names another composition')
  return head.generationId
}
