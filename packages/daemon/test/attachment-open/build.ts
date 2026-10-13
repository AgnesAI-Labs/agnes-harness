// Builds a session in the shape an older build left behind when a large attachment was queued:
// the attachment sits inline in inbox rows (once per queued item behind it) and again in the
// user message the next turn copied it into. Everything but the queue rows goes through the real
// supervisor and worker; the queue rows are written to the stored ledger directly, because the
// current build no longer produces them.
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendInboxRowsAsOlderBuild } from '@agnes/host/testkit'
import { toAcpPrompt } from '@agnes/protocol'
import { openSupervisor } from './harness.js'

export type LegacySessionOptions = {
  /** Size of the inline payload as the ledger stores it: this many MiB of base64 text, for a zip and for images alike. */
  attachmentMB: number
  kind: 'zip' | 'images'
  /** Items queued behind the attachment before a turn claims it. */
  queuedBehind: number
  /** Plain question-and-answer turns before the attachment. */
  prefixTurns: number
}

const MIB = 1024 * 1024
const IMAGE_BASE64_CHARS = 5 * MIB

/** A JPEG header, random scan data without any 0xFF, and an end marker, as base64 of `base64Chars`. */
function jpeg(base64Chars: number): string {
  const raw = randomBytes(Math.floor(base64Chars / 4) * 3)
  for (let i = 0; i < raw.length; i++) if (raw[i] === 0xff) raw[i] = 0xfe
  raw.set([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0])
  raw.set([0xff, 0xd9], raw.length - 2)
  return raw.toString('base64')
}

function attachmentBlocks(o: LegacySessionOptions): unknown[] {
  if (o.kind === 'zip')
    return [
      {
        type: 'file',
        mimeType: 'application/zip',
        name: 'insects.zip',
        data: randomBytes(Math.floor((o.attachmentMB * MIB) / 4) * 3).toString('base64'),
      },
    ]
  const blocks: unknown[] = []
  for (let left = o.attachmentMB * MIB; left > 0; left -= IMAGE_BASE64_CHARS)
    blocks.push({ type: 'image', mimeType: 'image/jpeg', data: jpeg(Math.min(IMAGE_BASE64_CHARS, left)) })
  return blocks
}

export async function buildLegacySession(
  dir: string,
  o: LegacySessionOptions,
): Promise<{ sessionId: string }> {
  const first = await openSupervisor(dir)
  let sessionId: string
  try {
    sessionId = (await first.must('session/new', { cwd: dir, mcpServers: [] })).sessionId as string
    for (let turn = 0; turn < o.prefixTurns; turn++)
      await first.must('session/prompt', {
        sessionId,
        prompt: toAcpPrompt([{ type: 'text', text: `small user turn ${turn} `.repeat(10) }]),
      })
  } finally {
    await first.close()
  }

  const attachment = { content: attachmentBlocks(o) }
  const queued = Array.from({ length: o.queuedBehind }, (_, i) => ({
    content: [{ type: 'text', text: `queued behind the attachment ${i + 1}` }],
  }))
  // One row per queue state: [attachment], [attachment, q1], [attachment, q1, q2], ...
  const snapshots = [attachment, ...queued].map((_, i, items) => items.slice(0, i + 1))
  await appendInboxRowsAsOlderBuild(dir, sessionId, snapshots)

  // The next prompt claims the attachment from the queue: the user message is a copy of the item,
  // with no conversion in between.
  const second = await openSupervisor(dir)
  try {
    await second.must('session/load', { sessionId, cwd: dir, mcpServers: [] })
    await second.must('session/prompt', {
      sessionId,
      prompt: toAcpPrompt([{ type: 'text', text: 'after' }]),
    })
  } finally {
    await second.close()
  }
  writeFileSync(join(dir, 'session-id'), sessionId)
  return { sessionId }
}
