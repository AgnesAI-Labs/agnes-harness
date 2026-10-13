import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { DEFAULT_RULES, redact } from '@agnes/base/privacy'
import { exportClaudeCode, exportShareGpt } from '@agnes/bridges/convert'
import { createPlatform } from '@agnes/host'
import {
  ARTIFACT_READ_RPC_MAX_BYTES,
  attachmentForm,
  type EventEnvelope,
  type SessionAttachmentReadParams,
  type SessionAttachmentReadResult,
  type UITimeline,
} from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { createPrivateFileSync, renameWriteThroughSync } from '@agnes/system-node'
import { CommandError, ExitCode, UsageError } from '../errors.js'
import { renderHtml } from '../html/template.js'
import type { ParsedArgs } from '../types.js'
import { writeWindowsPrivateExport } from './export-private-file.js'

export type LedgerExport = {
  events: EventEnvelope[]
  timeline: UITimeline
  lastSeq: number
}

type ExportSink = {
  write(chunk: string | Uint8Array): unknown
}

export type ExportDeps = {
  cwd: string
  io: { stdout: ExportSink; stderr: ExportSink }
  now?: () => Date
  home?: string
  username?: string
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>
}

export function sanitizeExportValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return `[OMITTED:binary:${value.byteLength} bytes]`
  if (Array.isArray(value)) return value.map(sanitizeExportValue)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (
    (record.type === 'image' || record.type === 'audio' || record.type === 'file') &&
    typeof record.data === 'string'
  )
    return { ...record, data: `[OMITTED:${record.type}:base64]` }
  if (record.type === 'base64' && typeof record.data === 'string')
    return { ...record, data: '[OMITTED:binary:base64]' }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, sanitizeExportValue(child)]))
}

function privacyRules(deps: ExportDeps) {
  const home = deps.home ?? homedir()
  return {
    ...DEFAULT_RULES,
    paths: {
      home,
      workspaceRoot: deps.cwd,
      username: deps.username ?? basename(home),
    },
  }
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  if (createPlatform().os === 'win32') return writeWindowsPrivateExport(path, bytes)
  const file = await open(path, 'w', 0o600)
  try {
    // `mode` only applies when the file is created. Tighten an existing destination before any raw
    // bytes are written so a former 0644 export cannot expose the replacement through that window.
    await file.chmod(0o600)
    await file.writeFile(bytes)
  } finally {
    await file.close()
  }
}

/**
 * Read a stable ledger prefix and the projection of that same prefix.
 *
 * Calling `client.session.attach` creates the sdk Session handle synchronously, before its returned
 * promise settles. The iterator is created in that window, which registers sdk's notification
 * listener before daemon can finish replaying rows inside the attach RPC; starting `events()` after
 * awaiting attach loses exactly those rows on an in-process transport.
 *
 * A client that already has a handle for this id cannot be made into a full-ledger reader. sdk
 * deduplicates admitted rows on the Session object and exposes no reset operation, so accepting one
 * would silently return a suffix. The CLI always boots a fresh client; other callers get a loud
 * refusal instead of a plausible but incomplete export.
 */
export async function readLedger(client: Client, id: string): Promise<LedgerExport> {
  // A durable sdk journal normally resumes at its saved position. Export is different: it needs the
  // whole retained ledger, so keep only the generation and explicitly rewind the exclusive cursor.
  const stored = await client.journal.cursor(id)
  // Restore only an existing durable session; an empty cwd lets the daemon recover its binding.
  // Do not create an SDK handle during load, which replays ACP rather than the export event stream.
  if (client.sessions.has(id))
    throw new UsageError(`cannot export ${id} with a client that already opened that session`)
  await client.restoreSession(id, '')
  // Nothing is read before every stored row has been verified: an open from a verified-head
  // checkpoint shows the history first and verifies it in the background, and an export must not
  // carry rows out (to be imported as a fresh, valid chain) that the verification would refuse.
  // No request deadline: verifying a long history can outlast `timeouts.request`.
  await client.session.verifyHistory(id)
  // A caller may have installed a handle while restoration was awaiting the daemon.
  if (client.sessions.has(id))
    throw new UsageError(`cannot export ${id} with a client that already opened that session`)
  const attaching = client.session.attach(id, {
    ...(stored ? { cursor: { fromSeq: 0, generation: stored.generation } } : {}),
    filter: { acpUpdates: false },
  })
  // Client.session.attach installs this handle before its first await. If that contract changes,
  // fail here rather than await the replay and then register a listener too late.
  const session = client.sessions.get(id)
  if (!session) throw new Error('sdk did not publish the session handle before attach')
  const iterator = session.events()[Symbol.asyncIterator]()
  // Also tracks events()'s own ensureAttached attempt. If the explicit attach fails, sdk may retry
  // that ensure; awaiting this promise during cleanup prevents such a retry from attaching after
  // readLedger has already returned an error.
  const first = iterator.next()
  let streamError: Error | undefined
  const offNotice = client.on('notice', (payload) => {
    const notice = payload as { kind?: unknown; sessionId?: unknown; seq?: unknown } | null
    if (notice?.kind !== 'invalid-event' || notice.sessionId !== id) return
    streamError = new Error(`invalid ledger event at sequence ${String(notice.seq)}`)
    // sdk deliberately drops an invalid row. Wake the reader now: waiting for the dropped final
    // sequence would otherwise turn a validation failure into an export that hangs forever.
    void iterator.return?.()
  })
  try {
    await attaching
    const lastSeq = session.lastServerSeq
    const events: EventEnvelope[] = []
    let next = await (lastSeq > 0 ? first : Promise.resolve({ done: true as const, value: undefined }))
    while (events.at(-1)?.seq !== lastSeq && lastSeq > 0) {
      if (next.done) {
        if (streamError) throw streamError
        throw new Error(`event stream ended at ${events.at(-1)?.seq ?? 0} before export target ${lastSeq}`)
      }
      const { _meta: _ignored, ...envelope } = next.value
      events.push(envelope)
      if (envelope.seq >= lastSeq) break
      next = await iterator.next()
    }
    // Zero is a real snapshot boundary. Omitting it asks for "latest", which can include a row that
    // arrived after an empty attach and make the timeline disagree with the exported ledger.
    const timeline = await session.projectUI(lastSeq)
    return { events, timeline, lastSeq }
  } finally {
    offNotice()
    await iterator.return?.()
    await first.catch(() => undefined)
    if (session.attached) await session.detach().catch(() => undefined)
  }
}

/**
 * The native export is one protocol envelope per UTF-8 line, with no sdk-only `_meta` wrapper. A
 * row read back whole through `session.exportRaw` is written as the line the daemon gave.
 */
export function formatAgnes(
  events: EventEnvelope[],
  lines: ReadonlyMap<number, string> = new Map(),
): Uint8Array {
  const text =
    events.length > 0
      ? `${events.map((event) => lines.get(event.seq) ?? JSON.stringify(event)).join('\n')}\n`
      : ''
  return new TextEncoder().encode(text)
}

/** Whether a row holds an attachment block in the lean form, whose bytes stayed in storage. */
function holdsOmitted(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 16) return false
  if (Array.isArray(value)) return value.some((item) => holdsOmitted(item, depth + 1))
  if (attachmentForm(value) === 'omitted') return true
  return Object.values(value).some((child) => holdsOmitted(child, depth + 1))
}

type RawPort = Pick<Client['session'], 'exportRaw'>

/** One stored row, whole, as the daemon serves it in pieces: its JSONL line without the newline. */
async function rawLine(session: RawPort, id: string, seq: number): Promise<string> {
  const pieces: Buffer[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const piece = await session.exportRaw(id, seq, offset)
    if (piece.seq !== seq) throw new CommandError(`export of ${id}: row ${seq} came back as row ${piece.seq}`)
    const bytes = Buffer.from(piece.base64, 'base64')
    pieces.push(bytes)
    if (piece.nextOffset !== null && piece.nextOffset !== offset + bytes.byteLength)
      throw new CommandError(`export of ${id}: row ${seq} was served out of order`)
    offset = piece.nextOffset
  }
  const line = Buffer.concat(pieces).toString('utf8')
  return line.endsWith('\n') ? line.slice(0, -1) : line
}

/**
 * A replay leaves large old inline attachments out of the rows it sends (the lean form). A raw
 * export puts each such row back whole, read through `session.exportRaw`, which serves only rows
 * whose history has been verified.
 */
export async function completeLeanRows(
  session: RawPort,
  id: string,
  events: readonly EventEnvelope[],
): Promise<{ events: EventEnvelope[]; lines: Map<number, string> }> {
  const lines = new Map<number, string>()
  const out: EventEnvelope[] = []
  for (const event of events) {
    if (!holdsOmitted(event.data)) {
      out.push(event)
      continue
    }
    const line = await rawLine(session, id, event.seq)
    const { _meta: _ignored, ...full } = JSON.parse(line) as EventEnvelope & { _meta?: unknown }
    if (full.seq !== event.seq || full.id !== event.id)
      throw new CommandError(`export of ${id}: the stored row ${event.seq} is not the row replayed`)
    lines.set(event.seq, line)
    out.push(full)
  }
  return { events: out, lines }
}

type StoredAttachment = Readonly<{
  sha256: string
  bytes: number
  at: Omit<SessionAttachmentReadParams, 'sessionId' | 'offset' | 'length'>
}>

/**
 * Every object a user message names: references and their thumbnails, located as the attachment
 * read finds them (the message seq, the kind, and the place among the message's blocks of that kind).
 */
function storedAttachments(events: readonly EventEnvelope[]): StoredAttachment[] {
  const found = new Map<string, StoredAttachment>()
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const content = (event.data as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) continue
    const places = { image: 0, file: 0 }
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'image' && block?.type !== 'file') continue
      const kind: 'image' | 'file' = block.type
      places[kind] += 1
      if (attachmentForm(block) !== 'reference') continue
      const at = { seq: event.seq, kind, index: places[kind] }
      const ref = block.attachment as { sha256?: unknown; bytes?: unknown }
      const thumb = block.thumbnail as { sha256?: unknown; bytes?: unknown } | undefined
      for (const [object, thumbnail] of [
        [ref, false],
        [thumb, true],
      ] as const)
        if (
          typeof object?.sha256 === 'string' &&
          /^[0-9a-f]{64}$/u.test(object.sha256) &&
          typeof object.bytes === 'number' &&
          !found.has(object.sha256)
        )
          found.set(object.sha256, {
            sha256: object.sha256,
            bytes: object.bytes,
            at: thumbnail ? { ...at, thumbnail: true } : at,
          })
    }
  }
  return [...found.values()]
}

async function digestOf(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Writes one attachment through a private temporary file, renamed into place once its digest matches. */
async function writeAttachment(
  call: Client['call'],
  id: string,
  dir: string,
  object: StoredAttachment,
): Promise<void> {
  const path = join(dir, object.sha256)
  if (existsSync(path) && (await digestOf(path)) === object.sha256) return
  const windows = createPlatform().os === 'win32'
  const temporary = join(dir, `.agnes-export-${randomUUID()}.tmp`)
  const fd = windows ? createPrivateFileSync(temporary) : openSync(temporary, 'wx', 0o600)
  let committed = false
  try {
    try {
      const hash = createHash('sha256')
      let offset = 0
      let total = object.bytes
      do {
        const window = await call<SessionAttachmentReadResult>('_agnes/v1/session.attachmentRead', {
          sessionId: id,
          ...object.at,
          offset,
          length: Math.max(1, Math.min(ARTIFACT_READ_RPC_MAX_BYTES, total - offset)),
        } satisfies SessionAttachmentReadParams)
        total = window.totalBytes
        const bytes = Buffer.from(window.base64, 'base64')
        if (bytes.byteLength === 0 && offset < total)
          throw new CommandError(`export of ${id}: attachment ${object.sha256} stopped at ${offset} bytes`)
        hash.update(bytes)
        writeSync(fd, bytes)
        offset += bytes.byteLength
      } while (offset < total)
      if (total !== object.bytes || hash.digest('hex') !== object.sha256)
        throw new CommandError(
          `export of ${id}: attachment ${object.sha256} does not match its reference; nothing more was exported`,
        )
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (windows) renameWriteThroughSync(temporary, path)
    else renameSync(temporary, path)
    committed = true
  } finally {
    if (!committed) rmSync(temporary, { force: true })
  }
}

/**
 * A raw native export also carries the bytes of every attachment its rows reference, one file per
 * object named by its digest in `<out>.attachments/`, read through `session.attachmentRead`. An
 * import of the export reads them from there.
 */
export async function exportAttachments(
  call: Client['call'],
  id: string,
  out: string,
  events: readonly EventEnvelope[],
): Promise<number> {
  const objects = storedAttachments(events)
  if (objects.length === 0) return 0
  const dir = `${out}.attachments`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const object of objects) await writeAttachment(call, id, dir, object)
  return objects.length
}

function formatFor(p: ParsedArgs): 'agnes' | 'html' | 'sharegpt' | 'claude-code' {
  return p.html ? 'html' : (p.format ?? 'agnes')
}

export function validateExportRequest(p: ParsedArgs): {
  id: string
  format: 'agnes' | 'html' | 'sharegpt' | 'claude-code'
} {
  const id = p.positional[0]
  if (!id || p.positional.length !== 1) throw new UsageError('export expects exactly one session id')
  const format = formatFor(p)
  return { id, format }
}

/**
 * Every export/share format is redacted before formatting by the shared privacy implementation.
 * `--raw` is still an explicit, warned escape hatch.
 */
export async function exportSession(p: ParsedArgs, deps: ExportDeps, client: Client): Promise<number> {
  const { id, format } = validateExportRequest(p)

  const ledger = await readLedger(client, id)
  if (p.raw) deps.io.stderr.write('warning: --raw exports without redaction (secrets, paths, PII)\n')
  const rules = privacyRules(deps)
  const raw = p.raw ? await completeLeanRows(client.session, id, ledger.events) : undefined
  const events = raw ? raw.events : (redact(sanitizeExportValue(ledger.events), rules) as EventEnvelope[])
  const timeline = p.raw
    ? ledger.timeline
    : (redact(sanitizeExportValue(ledger.timeline), rules) as UITimeline)
  const sessionId = p.raw ? id : redact(id, rules)
  const bytes =
    format === 'html'
      ? new TextEncoder().encode(
          renderHtml(timeline, {
            sessionId,
            exportedAt: (deps.now?.() ?? new Date()).toISOString(),
            redacted: !p.raw,
          }),
        )
      : format === 'sharegpt'
        ? exportShareGpt(events, { tools: 'role', id: sessionId })
        : format === 'claude-code'
          ? exportClaudeCode(events, { cwd: p.raw ? deps.cwd : redact(deps.cwd, rules) })
          : formatAgnes(events, raw?.lines)

  const path = p.out ? (isAbsolute(p.out) ? p.out : resolve(deps.cwd, p.out)) : undefined
  // The attachments are written before the rows, so an export that names them has them.
  if (raw && format === 'agnes') {
    if (path) await exportAttachments(client.call.bind(client), id, path, events)
    else if (storedAttachments(events).length > 0)
      deps.io.stderr.write('warning: attachment bytes are exported only with --out\n')
  }
  if (path) await (deps.writeFile ?? writePrivateFile)(path, bytes)
  else deps.io.stdout.write(bytes)
  return ExitCode.OK
}
