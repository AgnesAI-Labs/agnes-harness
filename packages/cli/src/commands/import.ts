import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { importSession, OLDER_EXPORT_FORMAT } from '@agnes/bridges/convert'
import { SessionAdmissionDenied } from '@agnes/daemon/local'
import { type AttachmentStore, createAttachmentStore, type Host, type HostSession } from '@agnes/host'
import { attachmentForm, type EventEnvelope, type SessionStart } from '@agnes/protocol'
import { CommandError, ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs, SessionAdmissionPort } from '../types.js'

type Sink = { write(chunk: string | Uint8Array): unknown }
export type ImportDeps = {
  env: NodeJS.ProcessEnv
  cwd: string
  host: Host
  admission: SessionAdmissionPort
  io: { stdout: Sink; stderr: Sink }
  readFile?: (path: string) => Uint8Array
}

const BATCH_SIZE = 500

type AppendEvent = Omit<EventEnvelope, 'seq'>

/** Pack only at a closed-turn boundary: core refuses a transaction ending on an open turn. */
export function importBatches(events: AppendEvent[], limit = BATCH_SIZE): AppendEvent[][] {
  const units: AppendEvent[][] = []
  let turn: AppendEvent[] | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (turn) throw new Error('import stream opens a turn before closing the previous turn')
      turn = [event]
      continue
    }
    if (turn) {
      turn.push(event)
      if (event.type === 'turn/end') {
        units.push(turn)
        turn = undefined
      }
      continue
    }
    if (event.type === 'turn/end') throw new Error('import stream closes a turn that is not open')
    units.push([event])
  }
  if (turn) throw new Error('import stream ends with an open turn')

  const batches: AppendEvent[][] = []
  let batch: AppendEvent[] = []
  for (const unit of units) {
    if (unit.length > limit)
      throw new Error(`one imported turn has ${unit.length} events, exceeding batch limit ${limit}`)
    if (batch.length > 0 && batch.length + unit.length > limit) {
      batches.push(batch)
      batch = []
    }
    batch.push(...unit)
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

const startData = (events: EventEnvelope[]): { key?: unknown; imported?: unknown } | undefined => {
  const data = events[0]?.type === 'session/start' ? events[0].data : undefined
  return data && typeof data === 'object' && !Array.isArray(data) ? data : undefined
}

const importedKey = (events: EventEnvelope[]): string | undefined => {
  const key = startData(events)?.key
  if (typeof key !== 'string' || key.length === 0) return undefined
  return key.startsWith('agnes:') ? key : `agnes:local:default:import:dm:${key}`
}

/**
 * The file's session/start is replaced by the target's own, so its provenance is carried over: an
 * existing marker verbatim (a re-imported export keeps its first source), else the native session's key.
 */
const importedMarker = (
  events: EventEnvelope[],
  source: string,
  cwd: string,
): SessionStart['imported'] | undefined => {
  const data = startData(events)
  const marker = data?.imported
  if (marker && typeof marker === 'object' && !Array.isArray(marker))
    return marker as SessionStart['imported']
  if (source !== 'agnes') return undefined
  const key = typeof data?.key === 'string' ? data.key : ''
  return { source: 'agnes', sourceId: key.slice(0, 256), cwd: cwd.slice(0, 4096) }
}

/** An import refused because its rows name attachment bytes it does not bring. */
export class ImportAttachmentError extends CommandError {
  constructor(
    readonly reason: 'ATTACHMENT_MISSING' | 'ATTACHMENT_HASH_MISMATCH',
    message: string,
  ) {
    super(message)
    this.name = 'ImportAttachmentError'
  }
}

type NamedObject = Readonly<{ sha256: string; bytes: number; mimeType: string }>

/** The stored objects user input rows name: attachment references and their thumbnails. */
function namedObjects(events: readonly EventEnvelope[]): NamedObject[] {
  const found = new Map<string, NamedObject>()
  const add = (value: unknown, mimeType: string) => {
    const v = value as { sha256?: unknown; bytes?: unknown } | null
    if (typeof v?.sha256 === 'string' && typeof v.bytes === 'number' && !found.has(v.sha256))
      found.set(v.sha256, { sha256: v.sha256, bytes: v.bytes, mimeType })
  }
  const visit = (content: unknown) => {
    if (!Array.isArray(content)) return
    for (const block of content as Array<Record<string, unknown>>) {
      if (attachmentForm(block) !== 'reference') continue
      add(block.attachment, String(block.mimeType))
      // Thumbnails are JPEG; the marker's type is informative only.
      if (block.thumbnail !== undefined) add(block.thumbnail, 'image/jpeg')
    }
  }
  for (const event of events) {
    const data = event.data as { content?: unknown; items?: unknown } | null
    if (event.type === 'user/message') visit(data?.content)
    if (event.type === 'inbox' && Array.isArray(data?.items))
      for (const item of data.items) visit((item as { content?: unknown } | null)?.content)
  }
  return [...found.values()]
}

/**
 * Imported rows meet the same rule as live input: a reference is written only for bytes the store
 * holds as a user attachment. An import brings them in `<file>.attachments/<sha256>`, which a raw
 * export writes; each is checked against its digest and size on the way in. A reference whose bytes
 * are neither there nor already stored refuses the whole import before anything is written.
 */
async function admitImportedAttachments(
  file: string,
  objects: readonly NamedObject[],
  store: AttachmentStore,
): Promise<void> {
  const dir = `${file}.attachments`
  const mismatch = (sha256: string) =>
    new ImportAttachmentError(
      'ATTACHMENT_HASH_MISMATCH',
      `${file}: ${join(dir, sha256)} is not the attachment the rows name; nothing was imported`,
    )
  for (const object of objects) {
    const side = join(dir, object.sha256)
    if (existsSync(side)) {
      const staging = await store.stage({
        kind: 'user-attachment',
        mimeType: object.mimeType,
        maxBytes: object.bytes,
      })
      let stored: Awaited<ReturnType<typeof staging.commit>>
      try {
        for await (const chunk of createReadStream(side, { highWaterMark: 1024 * 1024 }))
          await staging.write(chunk as Buffer)
        stored = await staging.commit(object.sha256)
      } catch (error) {
        await staging.abort().catch(() => undefined)
        const code = (error as { code?: unknown } | null)?.code
        if (code === 'ATTACHMENT_HASH_MISMATCH' || code === 'ATTACHMENT_TOO_LARGE')
          throw mismatch(object.sha256)
        throw error
      }
      if (stored.bytes !== object.bytes) throw mismatch(object.sha256)
      await store.markUserAttachment(stored, { mimeType: object.mimeType })
      continue
    }
    const marked = await store.userAttachment(object.sha256).catch(() => undefined)
    const stored = await store.stat(object.sha256)
    if (!marked || stored?.bytes !== object.bytes)
      throw new ImportAttachmentError(
        'ATTACHMENT_MISSING',
        `${file}: attachment ${object.sha256} is neither in ${dir} nor stored here; nothing was imported (a raw export with --out writes that directory)`,
      )
    // Marked again so the attachment sweep counts it as seen until the rows naming it are written.
    await store.markUserAttachment(stored, { mimeType: object.mimeType })
  }
}

export async function importFile(parsed: ParsedArgs, deps: ImportDeps): Promise<number> {
  if (parsed.connect || deps.env.AGNES_CONNECT)
    throw new UsageError('import only runs in one-shot form (no --connect)')
  const file = parsed.positional[0]
  if (!file || parsed.positional.length !== 1) throw new UsageError('import expects exactly one file')
  const converted = importSession((deps.readFile ?? readFileSync)(file), {
    from: parsed.from ?? 'auto',
    ...(parsed.key ? { sessionKey: parsed.key } : {}),
  })
  const key = parsed.key ?? importedKey(converted.events)
  if (!key) throw new Error('converted import has no target session key')
  // Native rows point at each other by sequence number (sourceEventSeqs, requestSeq, ...), so they
  // only stay true if every row lands on the sequence it was exported with. A skipped row -- a type
  // this build no longer knows, or a damaged line -- shifts the rest, so the import is refused.
  const hole = converted.report.source === 'agnes' ? converted.report.skipped[0] : undefined
  if (hole)
    throw new CommandError(
      hole.reason.startsWith(OLDER_EXPORT_FORMAT)
        ? `${file} line ${hole.line}: this export comes from an older format (${hole.reason}); an agnes export must keep every row, and this build cannot import it`
        : `${file} line ${hole.line}: ${hole.reason}; an agnes export must keep every row -- re-export it with this build`,
    )
  const objects = namedObjects(converted.events)
  if (objects.length > 0)
    await admitImportedAttachments(file, objects, createAttachmentStore({ dataDir: deps.host.dataDir }))
  // No session_start hooks: an extension may record a row there (code-mode notes that no kernel is
  // alive yet), and anything after session/start would move the imported body off its sequence.
  let reservedNew = false
  let session: HostSession
  try {
    const reserved = await deps.admission.reserve(key, deps.cwd)
    reservedNew = reserved.reservedNew
    const imported = importedMarker(converted.events, converted.report.source, reserved.binding.canonicalRoot)
    session = await deps.host
      .createSession({
        key,
        cwd: reserved.binding.canonicalRoot,
        binding: reserved.binding,
        skipSessionStartHooks: true,
        ...(imported ? { imported } : {}),
      })
      .catch((error: unknown) => {
        // Without --key an agnes export maps back onto its own session, which the daemon usually holds.
        if ((error as { code?: unknown } | null)?.code === 'E_WRITER_LEASE')
          throw new CommandError(
            `import target ${key} is open in another process -- rerun with --key <new-key>`,
          )
        throw error
      })
  } catch (error) {
    if (error instanceof SessionAdmissionDenied)
      throw new CommandError(
        `import target ${key} is not available to this local owner -- rerun with --key <new-key>`,
      )
    throw error
  }
  try {
    if (session.lastSeq !== 1)
      throw new CommandError(`import target ${key} is not fresh (last sequence ${session.lastSeq})`)
    const body = converted.events
      .filter((event) => event.type !== 'session/start')
      .map(({ seq: _sequence, ...event }) => event)
    let written = 0
    try {
      for (const batch of importBatches(body)) {
        await session.append(batch)
        written += batch.length
      }
    } catch (error) {
      const detail = (error as Error).message
      try {
        await session.discardNewSession()
      } catch (rollbackError) {
        const rollbackDetail = (rollbackError as Error).message
        throw new CommandError(
          `import of ${key} failed after ${written} of ${body.length} events and could not roll back the new target: ${detail}; rollback: ${rollbackDetail}`,
        )
      }
      throw new CommandError(
        `import of ${key} failed after ${written} of ${body.length} events; the new target was rolled back and may be retried with the same key: ${detail}`,
      )
    }
    try {
      deps.admission.activate(key, reservedNew)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      try {
        await session.discardNewSession()
      } catch (rollbackError) {
        const rollbackDetail = (rollbackError as Error).message
        throw new CommandError(
          `import of ${key} wrote ${written} events but could not admit the session and could not roll back the new target: ${detail}; rollback: ${rollbackDetail}`,
        )
      }
      throw new CommandError(
        `import of ${key} wrote ${written} events but could not admit the session; the new target was rolled back and may be retried with the same key: ${detail}`,
      )
    }
    deps.io.stdout.write(
      `imported ${written} events into ${key} (source ${converted.report.source}; skipped ${converted.report.skipped.length}, repaired ${converted.report.repaired.length}, branches dropped ${converted.report.branches.dropped})\n`,
    )
    for (const skipped of converted.report.skipped.slice(0, 20))
      deps.io.stderr.write(`skipped line ${skipped.line}: ${skipped.reason}\n`)
    return ExitCode.OK
  } finally {
    await session.close().catch(() => undefined)
  }
}
