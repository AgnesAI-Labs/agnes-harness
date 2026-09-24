import { readFileSync } from 'node:fs'
import { importSession, OLDER_EXPORT_FORMAT } from '@agnes/bridges/convert'
import { SessionAdmissionDenied } from '@agnes/daemon/local'
import type { Host, HostSession } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
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

const importedKey = (events: EventEnvelope[]): string | undefined => {
  const data = events[0]?.type === 'session/start' ? events[0].data : undefined
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const key = (data as { key?: unknown }).key
  if (typeof key !== 'string' || key.length === 0) return undefined
  return key.startsWith('agnes:') ? key : `agnes:local:default:import:dm:${key}`
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
  // No session_start hooks: an extension may record a row there (code-mode notes that no kernel is
  // alive yet), and anything after session/start would move the imported body off its sequence.
  let reservedNew = false
  let session: HostSession
  try {
    const reserved = await deps.admission.reserve(key, deps.cwd)
    reservedNew = reserved.reservedNew
    session = await deps.host
      .createSession({
        key,
        cwd: reserved.binding.canonicalRoot,
        binding: reserved.binding,
        skipSessionStartHooks: true,
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
