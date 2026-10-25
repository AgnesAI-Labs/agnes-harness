import { resolve } from 'node:path'
import { importSession, OLDER_EXPORT_FORMAT } from '@agnes/bridges/convert'
import { SessionAdmissionDenied } from '@agnes/daemon/local'
import type { Host, HostSession } from '@agnes/host'
import type { EventEnvelope, SessionStart } from '@agnes/protocol'
import type { LocalBootDeps } from '../boot/local.js'
import { CommandError, ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs, SessionAdmissionPort } from '../types.js'
import { readImportFile } from './import-file.js'
import { bundleOriginals, readNativeBundle } from './native-bundle.js'

type Sink = { write(chunk: string | Uint8Array): unknown }
export type ImportDeps = {
  env: NodeJS.ProcessEnv
  cwd: string
  host: Host
  admission: SessionAdmissionPort
  io: { stdout: Sink; stderr: Sink }
  readFile?: (path: string) => Uint8Array
  /** Told the target key once the import is committed; the TUI uses it to point at /resume. */
  imported?: (key: string) => void
}

const BATCH_SIZE = 500

type AppendEvent = Omit<EventEnvelope, 'seq'>

/**
 * Pack only at a closed-turn boundary: core refuses a transaction ending on an open turn, because an
 * open turn must hold a program counter that an export does not carry. A turn is therefore the
 * smallest unit, and a turn longer than `limit` is appended alone as one transaction of its own.
 */
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

export async function importFile(parsed: ParsedArgs, deps: ImportDeps): Promise<number> {
  if (parsed.connect || deps.env.AGNES_CONNECT)
    throw new UsageError('import only runs in one-shot form (no --connect)')
  const file = parsed.positional[0]
  if (!file || parsed.positional.length !== 1) throw new UsageError('import expects exactly one file')
  const bytes = (deps.readFile ?? readImportFile)(resolve(deps.cwd, file))
  const bundle = await readNativeBundle(resolve(deps.cwd, file), bytes)
  const converted = importSession(bundle?.raw ?? bytes, {
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
  const originals = bundleOriginals(converted.events)
  if (originals.length && !bundle) throw new CommandError('native import requires original artifact sidecars')
  if (
    bundle &&
    (converted.events.at(-1)?.seq !== bundle.manifest.lastSeq ||
      JSON.stringify(originals) !== JSON.stringify(bundle.manifest.originals))
  )
    throw new CommandError('native bundle ledger and original declarations disagree')
  // Validate every transaction boundary before reserving or opening any target.
  const body = converted.events
    .filter((event) => event.type !== 'session/start')
    .map(({ seq: _sequence, ...event }) => event)
  const batches = importBatches(body)
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
        // Title generation and approval expiry append rows in reply to imported ones; landing between
        // two batches, one would shift every later row off its exported sequence.
        skipBackgroundWriters: true,
        requireNew: true,
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
    let written = 0
    const attachments = session.d.runtime.attachmentStore()
    const receipts: Array<{
      scope: { sessionKey: string; lane: string }
      receipt: Awaited<ReturnType<NonNullable<typeof attachments>['store']>>
    }> = []
    try {
      if (originals.length && !attachments) throw new Error('native import attachment storage unavailable')
      for (const { lane, ref } of originals) {
        const bytes = await bundle?.readOriginal(ref)
        if (!bytes) throw new Error('native bundle original is missing')
        const scope = { sessionKey: key, lane }
        const receipt = await attachments?.store(scope, bytes, ref.mime, new AbortController().signal)
        if (!receipt) throw new Error('native import attachment storage unavailable')
        receipts.push({ scope, receipt })
        const stored = receipt.artifact
        if (stored.sha256 !== ref.sha256 || stored.size !== ref.size || stored.mime !== ref.mime)
          throw new Error('native import artifact store identity mismatch')
      }
      for (const batch of batches) {
        // Each batch must start right after the last imported row and land contiguously; anything
        // else means another writer reached the target, and the import is refused and rolled back.
        const expected = written + 2
        if (session.lastSeq !== expected - 1)
          throw new Error(`import target moved to sequence ${session.lastSeq} before row ${expected}`)
        const { seqs } = await session.append(batch)
        if (seqs[0] !== expected || seqs.at(-1) !== expected + batch.length - 1)
          throw new Error(`import batch landed at sequence ${seqs[0]} instead of ${expected}`)
        written += batch.length
      }
      for (const { scope, receipt } of receipts) await attachments?.confirm(scope, receipt.id)
    } catch (error) {
      const detail = (error as Error).message
      // Keep pending roots until rollback has removed every possibly committed reference.
      try {
        await session.discardNewSession()
        for (const { scope, receipt } of receipts) await attachments?.discard(scope, receipt.id)
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
    deps.imported?.(key)
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

const SOURCES = ['claude-code', 'codex', 'pi', 'auto'] as const

/**
 * What the TUI's /import runs: the same one-shot path as `agh import FILE`, on a local Host booted for
 * the purpose and closed afterwards. Failures are thrown for the caller to show; the key comes back on success.
 */
export async function importInto(
  p: ParsedArgs,
  deps: LocalBootDeps,
  where: { cwd: string; env: NodeJS.ProcessEnv },
  file: string,
  from?: string,
): Promise<{ key: string }> {
  if (from !== undefined && !(SOURCES as readonly string[]).includes(from))
    throw new UsageError(`--from must be one of ${SOURCES.join('|')}`)
  const { bootLocal } = await import('../boot/local.js')
  const args: ParsedArgs = {
    positional: [file],
    rest: [],
    command: 'import',
    print: false,
    help: false,
    version: false,
    continue: false,
    park: false,
    ephemeral: false,
    json: false,
    repair: false,
    upgrade: false,
    html: false,
    raw: false,
    resolved: false,
    archived: false,
    force: false,
    probe: false,
    ...(p.profile ? { profile: p.profile } : {}),
    ...(p.cwd ? { cwd: p.cwd } : {}),
    ...(from ? { from: from as NonNullable<ParsedArgs['from']> } : {}),
  }
  const booted = await bootLocal(args, deps)
  try {
    if (booted.host === undefined || booted.sessionAdmission === undefined)
      throw new CommandError('local import requires a Host')
    let key: string | undefined
    const sink = { write: () => true }
    await importFile(args, {
      env: where.env,
      cwd: where.cwd,
      host: booted.host,
      admission: booted.sessionAdmission,
      io: { stdout: sink, stderr: sink },
      imported: (k) => {
        key = k
      },
    })
    if (key === undefined) throw new CommandError('import finished without a session key')
    return { key }
  } finally {
    await booted.close().catch(() => undefined)
  }
}
