import type { SessionJob } from '@agnes/protocol'
import { escapeControl } from './component.js'
import { stripVT } from './markdown.js'

/** The most output the `[Shell #N]` chip carries into the next message. */
export const CHIP_OUTPUT_BYTES = 16 * 1024
/** Rows of output the timeline card keeps; earlier rows are summarised. */
const CARD_ROWS = 200

/** Where a `!` line is a shell command: the first character of the draft. `!!` keeps the output local. */
export const isBangLine = (text: string): boolean => text.startsWith('!')

export function parseBang(text: string): { local: boolean; command: string } {
  const local = text.startsWith('!!')
  return { local, command: text.slice(local ? 2 : 1).trim() }
}

/**
 * Shell output and command lines are untrusted text: escape sequences are removed whole (not just their
 * ESC byte), a carriage return overwrites its line the way a terminal does, and every other control
 * character goes. Newlines stay.
 */
export function cleanShellText(text: string): string {
  return escapeControl(
    stripVT(text)
      .replaceAll('\r\n', '\n')
      .split('\n')
      .map((line) => line.slice(line.lastIndexOf('\r') + 1))
      .join('\n')
      .replaceAll('\t', '    '),
  )
}

/** stdout then stderr, as one cleaned text. */
export function outputOf(job: Pick<SessionJob, 'stdout' | 'stderr'>): string {
  const out = cleanShellText(job.stdout ?? '')
  const err = cleanShellText(job.stderr ?? '')
  return out && err && !out.endsWith('\n') ? `${out}\n${err}` : out + err
}

/** The last rows of `text`, with a count of what was left out. */
export function tailRows(text: string, rows = CARD_ROWS): { text: string; omitted: number } {
  const lines = text.replace(/\n$/, '').split('\n')
  return lines.length <= rows
    ? { text: lines.join('\n'), omitted: 0 }
    : { text: lines.slice(-rows).join('\n'), omitted: lines.length - rows }
}

/** The last `max` bytes of `text`, cut on a character boundary. */
export function tailBytes(text: string, max = CHIP_OUTPUT_BYTES): { text: string; cut: boolean } {
  const bytes = Buffer.from(text)
  if (bytes.length <= max) return { text, cut: false }
  let start = bytes.length - max
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
  return { text: bytes.subarray(start).toString('utf8'), cut: true }
}

/**
 * What the next message carries for a finished `!cmd`: the command, how it ended and the tail of its
 * output. Written for the model, so the labels are fixed English, not the interface language.
 */
export function chipText(chip: string, command: string, job: SessionJob, seconds: number): string {
  const { text, cut } = tailBytes(outputOf(job))
  const ended =
    job.status === 'killed'
      ? 'stopped before it finished'
      : job.code === null
        ? 'did not report an exit code'
        : `exit code ${job.code}`
  return [
    `${chip} The user ran this shell command themselves in the workspace (not part of the conversation):`,
    `$ ${cleanShellText(command)}`,
    `${ended}, ${seconds.toFixed(1)}s`,
    text
      ? `output${cut ? ` (the last ${CHIP_OUTPUT_BYTES / 1024} KiB; earlier output was cut)` : ''}${job.truncated ? ' (capture limit reached; output may be incomplete)' : ''}:\n${text}`
      : 'no output',
  ].join('\n')
}
