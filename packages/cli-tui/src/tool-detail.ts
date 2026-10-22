import type { ToolDetail } from '@agnes/sdk'

/** What the card knows of a tool's full record: still fetching, fetched, or why it could not be. */
export type ToolDetailState =
  | { state: 'loading' }
  | { state: 'ready'; args: string; result?: string }
  | { state: 'failed'; reason: string }

// A card redraws on every frame; a multi-megabyte result is cut here, not wrapped per frame.
const MAX_CHARS = 100_000
const clip = (text: string): string => (text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…` : text)

/** Full arguments and result text of one durable tool record. External text: escaped where it is drawn. */
export function toolDetailText({ call, result }: ToolDetail): { args: string; result?: string } {
  return {
    args: clip(JSON.stringify(call.args, null, 2) ?? ''),
    ...(result
      ? { result: clip(result.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')) }
      : {}),
  }
}
