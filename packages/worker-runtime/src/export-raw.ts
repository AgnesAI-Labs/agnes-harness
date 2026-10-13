import type { HostSession } from '@agnes/host'
import { rpcError } from '@agnes/protocol'

/** Raw bytes per `exportRaw` piece; base64 of this fits one worker frame and one client frame. */
export const EXPORT_RAW_CHUNK_BYTES = 8 * 1024 * 1024
/** A row nobody has asked a piece of for this long is dropped; the next piece reads it again. */
export const EXPORT_RAW_IDLE_MS = 60_000
/** Rows held per session at once, so two exports interleaving their pieces do not re-read each piece. */
const SLOTS_PER_SESSION = 2

type ExportSession = Pick<HostSession, 'scan'>
type Page = { seq: number; base64: string; nextOffset: number | null }
type Slot = { bytes: Promise<Buffer>; timer?: unknown }
type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }

export type RawExporter = {
  /** One piece of a stored row's envelope as one JSONL line (its JSON and a newline). */
  chunk(session: ExportSession, seq: number, offset: number): Promise<Page>
  /** Drops every row held for `session`; called when the session closes. */
  release(session: ExportSession): void
}

const nodeTimers: Timers = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    // An abandoned export must not keep a worker process alive.
    timer.unref?.()
    return timer
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

async function readLine(session: ExportSession, seq: number): Promise<Buffer> {
  let rows: unknown[] | undefined = await session.scan({ fromSeq: seq, toSeq: seq, limit: 1 })
  if (!rows[0]) throw rpcError('INVALID_PARAMS', { reason: 'row-not-found', seq })
  // Drop the parsed row before the bytes are built, and the string once they are: the three are
  // never all held at once.
  let text: string | undefined = `${JSON.stringify(rows[0])}\n`
  rows = undefined
  const bytes = Buffer.from(text, 'utf8')
  text = undefined
  return bytes
}

/**
 * Serves stored rows in pieces. A row is read once per export: one load per (session, seq) is shared
 * by concurrent pieces and held until its last piece is served, the session closes, or no piece of
 * it has been asked for in `idleMs`. At most two rows per session are held, so exports that
 * interleave two rows read each once; a third row pushes out the least recently used one.
 */
export function createRawExporter(o: { idleMs?: number; timers?: Timers } = {}): RawExporter {
  const idleMs = o.idleMs ?? EXPORT_RAW_IDLE_MS
  const timers = o.timers ?? nodeTimers
  const held = new WeakMap<object, Map<number, Slot>>()

  const drop = (slots: Map<number, Slot>, seq: number) => {
    const slot = slots.get(seq)
    if (!slot) return
    if (slot.timer !== undefined) timers.clearTimeout(slot.timer)
    slots.delete(seq)
  }

  return {
    async chunk(session, seq, offset) {
      if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(offset) || offset < 0)
        throw rpcError('INVALID_PARAMS', { reason: 'invalid-position' })
      let slots = held.get(session)
      if (!slots) {
        slots = new Map()
        held.set(session, slots)
      }
      const owner = slots
      let slot = slots.get(seq)
      if (slot) {
        // Re-inserted below, as the most recently used.
        slots.delete(seq)
        if (slot.timer !== undefined) timers.clearTimeout(slot.timer)
      } else {
        const loading: Slot = { bytes: readLine(session, seq) }
        // A failed read is not kept, so the next piece tries again.
        loading.bytes.catch(() => {
          if (owner.get(seq) === loading) drop(owner, seq)
        })
        slot = loading
      }
      const current = slot
      slot.timer = timers.setTimeout(() => {
        if (owner.get(seq) === current) owner.delete(seq)
      }, idleMs)
      slots.set(seq, slot)
      while (slots.size > SLOTS_PER_SESSION) drop(slots, slots.keys().next().value as number)
      const bytes = await slot.bytes
      if (offset > bytes.length) throw rpcError('INVALID_PARAMS', { reason: 'offset-out-of-range', seq })
      const end = Math.min(bytes.length, offset + EXPORT_RAW_CHUNK_BYTES)
      const base64 = bytes.subarray(offset, end).toString('base64')
      if (end === bytes.length && owner.get(seq) === current) drop(owner, seq)
      return { seq, base64, nextOffset: end === bytes.length ? null : end }
    },
    release(session) {
      const slots = held.get(session)
      if (!slots) return
      for (const seq of [...slots.keys()]) drop(slots, seq)
      held.delete(session)
    },
  }
}

const shared = createRawExporter()

/** One piece of a stored row from the process-wide exporter. */
export function exportRawChunk(session: ExportSession, seq: number, offset: number): Promise<Page> {
  return shared.chunk(session, seq, offset)
}

/** Drops the rows the process-wide exporter holds for a closing session. */
export function releaseRawExport(session: ExportSession): void {
  shared.release(session)
}
