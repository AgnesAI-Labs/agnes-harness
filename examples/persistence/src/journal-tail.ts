import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type Change = [string, unknown] | [string]
export type Frame = {
  version: 1
  revision: number
  previous: string | null
  changes: Change[]
  digest: string
}
export const digest = (changes: Change[], revision: number, previous: string | null): string =>
  createHash('sha256')
    .update(JSON.stringify([revision, previous, changes]))
    .digest('hex')
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code })
}
const valid = (frame: Frame) =>
  frame?.version === 1 &&
  (frame.previous === null || typeof frame.previous === 'string') &&
  Array.isArray(frame.changes) &&
  frame.changes.every(
    (change) =>
      Array.isArray(change) && typeof change[0] === 'string' && (change.length === 1 || change.length === 2),
  ) &&
  Number.isSafeInteger(frame.revision) &&
  frame.revision > 0 &&
  frame.digest === digest(frame.changes, frame.revision, frame.previous)

export function readJournalTail(bytes: Buffer) {
  const frames: Frame[] = []
  let revision = 0
  let previous: string | null = null
  let badOffset: number | undefined
  for (let offset = 0; offset < bytes.length; ) {
    const newline = bytes.indexOf(10, offset)
    const end = newline < 0 ? bytes.length : newline + 1
    const line = bytes.subarray(offset, newline < 0 ? end : newline).toString('utf8')
    let frame: Frame | undefined
    try {
      frame = JSON.parse(line) as Frame
    } catch {
      /* A damaged tail is quarantined below. */
    }
    if (offset === 0 && frame && typeof frame === 'object' && !('version' in frame))
      fail('E_FORMAT', 'Unsupported JSONL journal version header; this runtime supports version 1')
    if (frame && typeof frame === 'object' && 'version' in frame && frame.version !== 1)
      fail('E_FORMAT', `Unsupported JSONL journal version ${frame.version}; this runtime supports version 1`)
    const checked = frame && valid(frame)
    if (badOffset !== undefined) {
      if (checked)
        fail('E_STORAGE_FAULT', 'Valid transactions follow journal damage; automatic truncation refused')
    } else if (!checked) badOffset = offset
    else {
      if (frame.revision !== revision + 1 || frame.previous !== previous)
        fail('E_STORAGE_FAULT', 'Journal chain mismatch; automatic truncation refused')
      frames.push(frame)
      revision = frame.revision
      previous = frame.digest
    }
    offset = end
  }
  if (badOffset !== undefined && frames.length === 0)
    fail('E_STORAGE_FAULT', 'JSONL journal has no valid transaction prefix; automatic truncation refused')
  return { frames, revision, previous, badOffset }
}

function durableWrite(path: string, bytes: Uint8Array) {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Atomic replacement couples tail removal to the recovery audit and no-replay counter fences. */
export function replaceDamagedJournal(
  path: string,
  bytes: Buffer,
  badOffset: number,
  frame: Frame,
): { diagnosticId: string; quarantineFile: string } {
  const audit = frame.changes.find(([key]) => key === JSON.stringify(['journal-recovery']))
  if (audit?.length !== 2 || !audit[1] || typeof audit[1] !== 'object')
    throw new Error('Recovery audit missing')
  const diagnosticId = (audit[1] as { diagnosticId: string }).diagnosticId
  const quarantineFile = `${path}.tail-${diagnosticId}.bin`
  durableWrite(quarantineFile, bytes.subarray(badOffset))
  const parent = openSync(dirname(path), 'r')
  try {
    fsyncSync(parent)
    const staged = `${path}.recovery-${randomUUID()}.tmp`
    durableWrite(
      staged,
      Buffer.concat([bytes.subarray(0, badOffset), Buffer.from(`${JSON.stringify(frame)}\n`)]),
    )
    renameSync(staged, path)
    fsyncSync(parent)
  } finally {
    closeSync(parent)
  }
  return { diagnosticId, quarantineFile }
}
