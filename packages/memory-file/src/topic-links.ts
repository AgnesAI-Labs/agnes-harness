import { hash } from './content.js'
import type { MetaStore } from './meta.js'
import { parseParagraphs } from './paragraphs.js'
import type { CommitObserver, ViewFilter } from './pipeline.js'
import type { HideRange } from './view.js'

type Binding = Readonly<{ topic: string; topicHash: string }>
type LinkState = Readonly<{ status: 'missing' | 'valid' | 'corrupt'; bindings: Map<string, Binding> }>
const filename = 'links.json'
const digest = /^[0-9a-f]{64}$/u
const link =
  /\]\(([^)\s]+\.md)(?:#[^)\s]*)?(?:\s+"[^"]*")?\)|\[\[([^\]#]+\.md)(?:#[^\]]*)?\]\]|^\[[^\]]+\]:\s*(\S+\.md)(?:#\S*)?/gu

function readLinkState(meta: MetaStore): LinkState {
  const data = meta.readJson<{ version?: unknown; bindings?: unknown }>(filename)
  if (data === undefined) {
    return { status: meta.has(filename) ? 'corrupt' : 'missing', bindings: new Map() }
  }
  const bindings = new Map<string, Binding>()
  if (
    data.version !== 1 ||
    !data.bindings ||
    typeof data.bindings !== 'object' ||
    Array.isArray(data.bindings)
  )
    return { status: 'corrupt', bindings }
  for (const [key, value] of Object.entries(data.bindings)) {
    if (
      !digest.test(key) ||
      !value ||
      typeof value.topic !== 'string' ||
      typeof value.topicHash !== 'string' ||
      !digest.test(value.topicHash)
    )
      return { status: 'corrupt', bindings: new Map() }
    bindings.set(key, { topic: value.topic, topicHash: value.topicHash })
  }
  return { status: 'valid', bindings }
}

export function topicLinksFingerprint(meta: MetaStore): readonly [string, string, string][] {
  const state = readLinkState(meta)
  if (state.status === 'corrupt') return [['corrupt', '', '']]
  return [...state.bindings]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, binding]) => [key, binding.topic, binding.topicHash])
}

function* summaries(content: string) {
  for (const line of content.matchAll(/[^\n]*\n|[^\n]+$/gu)) {
    const text = line[0].replace(/\r?\n$/u, '')
    const topics = new Set<string>()
    for (const match of text.matchAll(link)) topics.add(match[1] ?? match[2] ?? match[3]!)
    if (topics.size) {
      const key = hash(text.trim().toLowerCase().replace(/\s+/gu, ' '))
      yield { key, text, topics, start: line.index, end: line.index + line[0].length }
    }
  }
}

export const topicLinksObserver: CommitObserver = (intent, committed, ctx) => {
  // Each store commit changes one file. A later topic commit cannot confirm the summary's wording.
  if (committed.path !== 'MEMORY.md') return
  const before = new Set(Array.from(summaries(intent.before.content), (line) => line.text))
  const after = [...summaries(committed.content)]
  const { status, bindings: previous } = readLinkState(ctx.meta)
  const unchanged = new Set(after.filter((line) => before.has(line.text)).map((line) => line.key))
  const parsed = parseParagraphs(committed.content)
  const managed = [...parsed.paragraphs, ...parsed.anomalies]
  const files = new Map(ctx.files.map((entry) => [entry.path, entry]))
  const bindings = new Map<string, Binding>()
  for (const { key, topics, start, end } of after) {
    // A v1 binding vouches for one topic. A line referring to several must fail closed for recall.
    if (topics.size !== 1) continue
    const [topic] = topics
    const target = files.get(topic!)
    const inManaged = managed.some((span) => start >= span.start && end <= span.end)
    // A human saving MEMORY.md confirms ordinary summary lines without having to reword them.
    // Agent/host edits and managed paragraphs keep their previous binding unless rewritten.
    if (unchanged.has(key) && (intent.origin !== 'human' || inManaged)) {
      const binding = previous.get(key)
      if (binding) bindings.set(key, binding)
    } else if (target?.bytes) {
      bindings.set(key, { topic: target.path, topicHash: target.hash })
    }
  }
  if (bindings.size || previous.size || (intent.origin === 'human' && status === 'corrupt'))
    ctx.meta.writeJson(filename, { version: 1, bindings: Object.fromEntries(bindings) })
}

export const topicLinksViewFilter: ViewFilter = (entry, ctx) => {
  if (entry.path !== 'MEMORY.md') return []
  const lines = [...summaries(entry.content)]
  if (!lines.length) return []
  const { status, bindings } = readLinkState(ctx.meta)
  const files = new Map(ctx.files.map((file) => [file.path, file]))
  const ranges: HideRange[] = []
  for (const { key, topics, start, end } of lines) {
    const binding = bindings.get(key)
    for (const topic of topics) {
      const target = files.get(topic)
      if (target?.bytes && binding?.topic === topic && binding.topicHash === target.hash) continue
      // Pre-upgrade or never-bound summaries referencing an existing topic stay visible in the note,
      // while recall and saved-paragraph projection still require a verified binding.
      if (target?.bytes && !binding && status !== 'corrupt') {
        ranges.push({ start, end, appliesTo: 'index', reason: 'topic-unverified' })
        continue
      }
      const notice = target?.bytes
        ? `[Summary of ${topic} may be outdated; read ${topic}]`
        : `[Summary of ${topic} removed: topic no longer exists]`
      ranges.push({
        start,
        end,
        appliesTo: 'note',
        reason: target?.bytes ? 'topic-outdated' : 'topic-missing',
        notice,
        readNotice: notice,
      })
    }
  }
  return ranges
}
