import type { CompactionInput, CompactionOutput, SurfaceNode } from '@agnes/extension-api'
import { chooseCut } from './cut.js'

/** Engine-level prune and image offload. Triggers stay in Core. */
export type CompactionQualityConfig = {
  thresholdChars: number
  headChars: number
  tailChars: number
  marker: string
  imageBudgetBytes: number
}

export const DEFAULT_COMPACTION_QUALITY: CompactionQualityConfig = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
  marker: '\n\n[... tool result middle pruned ...]\n\n',
  imageBudgetBytes: 1_048_576,
}

const CJK_CHAR = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힣]/

/** Same character mix as Core's estimator, duplicated so this package does not import the loop. */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.7 + other / 4)
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

export function resolveCompactionQualityConfig(
  input?: Partial<CompactionQualityConfig>,
): CompactionQualityConfig {
  return {
    thresholdChars: positive(input?.thresholdChars, DEFAULT_COMPACTION_QUALITY.thresholdChars),
    headChars: positive(input?.headChars, DEFAULT_COMPACTION_QUALITY.headChars),
    tailChars: positive(input?.tailChars, DEFAULT_COMPACTION_QUALITY.tailChars),
    marker: typeof input?.marker === 'string' ? input.marker : DEFAULT_COMPACTION_QUALITY.marker,
    imageBudgetBytes: positive(input?.imageBudgetBytes, DEFAULT_COMPACTION_QUALITY.imageBudgetBytes),
  }
}

function pruneToolText(text: string, config: CompactionQualityConfig): string {
  if (text.length <= config.thresholdChars) return text
  if (config.headChars + config.tailChars + config.marker.length >= text.length) return text
  return text.slice(0, config.headChars) + config.marker + text.slice(-config.tailChars)
}

type ImageRecord = { data: string; mimeType?: unknown }

function isImage(value: unknown): value is ImageRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'image' &&
    typeof (value as { data?: unknown }).data === 'string'
  )
}

function imageBytes(data: string): number {
  return Math.floor((data.length * 3) / 4)
}

function collectImages(value: unknown, out: ImageRecord[]): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectImages(item, out)
    return
  }
  if (isImage(value)) out.push(value)
  for (const child of Object.values(value)) collectImages(child, out)
}

function renderValue(
  value: unknown,
  config: CompactionQualityConfig,
  offloaded: WeakSet<object>,
  prune: boolean,
): { text: string; shortened: boolean } {
  if (typeof value === 'string') {
    if (!prune) return { text: value, shortened: false }
    const next = pruneToolText(value, config)
    return { text: next, shortened: next !== value }
  }
  if (Array.isArray(value)) {
    let shortened = false
    let text = ''
    for (const item of value) {
      const part = renderValue(item, config, offloaded, prune)
      text += part.text
      shortened = shortened || part.shortened
    }
    return { text, shortened }
  }
  if (!value || typeof value !== 'object') return { text: '', shortened: false }
  if (isImage(value)) {
    if (offloaded.has(value)) {
      const mime = typeof value.mimeType === 'string' ? value.mimeType : 'application/octet-stream'
      return {
        text: `[image offloaded ${mime} ${imageBytes(value.data)} bytes]`,
        shortened: true,
      }
    }
    return { text: '', shortened: false }
  }
  const record = value as Record<string, unknown>
  if (record.type === 'text' && typeof record.text === 'string')
    return renderValue(record.text, config, offloaded, prune)
  if ('content' in record) return renderValue(record.content, config, offloaded, prune)
  return { text: '', shortened: false }
}

/**
 * Elide old oversized tool results and images inside the summarize range. Returns null when nothing
 * was shortened or the elision is not strictly smaller, so today's planner still runs. The summary
 * model reads the real ledger; this replacement is the only engine-level effect that lands.
 */
export function prepareCompaction(
  input: CompactionInput,
  config: CompactionQualityConfig = DEFAULT_COMPACTION_QUALITY,
): CompactionOutput | null {
  const surface: SurfaceNode[] = input.conversation.map((node) => ({
    seq: node.seq,
    type:
      node.kind === 'user'
        ? 'user/message'
        : node.kind === 'assistant'
          ? 'assistant/message'
          : node.kind === 'tool_result'
            ? 'tool/result'
            : 'summary',
    pinned: node.pinned,
    tokensEstimate: node.tokensEstimate,
  }))
  const cut = chooseCut(surface, input.budget.keepRecentTokens)
  if (!cut) return null
  const start = input.conversation.findIndex((node) => node.seq === cut.summarizeRange[0])
  const end = input.conversation.findIndex((node) => node.seq === cut.summarizeRange[1])
  if (start < 0 || end < start || end >= input.conversation.length - 1) return null
  const prefix = input.conversation.slice(start, end + 1)
  const images: ImageRecord[] = []
  for (const node of prefix) collectImages(node.data, images)
  let imageTotal = images.reduce((sum, image) => sum + imageBytes(image.data), 0)
  const offloaded = new WeakSet<object>()
  let shortened = false
  for (const image of images) {
    if (imageTotal <= config.imageBudgetBytes) break
    offloaded.add(image)
    imageTotal -= imageBytes(image.data)
    shortened = true
  }
  const parts: string[] = []
  for (const node of prefix) {
    const rendered = renderValue(node.data, config, offloaded, node.kind === 'tool_result')
    if (rendered.text) parts.push(rendered.text)
    shortened = shortened || rendered.shortened
  }
  if (!shortened) return null
  const text = parts.join('\n')
  const before = prefix.reduce((sum, node) => sum + node.tokensEstimate, 0)
  if (!text.trim() || estimateTokens(text) >= before) return null
  const first = prefix[0]
  const last = prefix[prefix.length - 1]
  if (!first || !last) return null
  return { kind: 'replacement', range: [first.seq, last.seq], text, mode: 'elision' }
}
