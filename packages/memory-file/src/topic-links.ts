import { hash } from './content.js'
import type { MetaStore } from './meta.js'
import type { CommitObserver, ViewFilter } from './pipeline.js'
import type { HideRange } from './view.js'

type Binding = Readonly<{ topic: string; topicHash: string }>
const filename = 'links.json'
const digest = /^[0-9a-f]{64}$/u
const link =
  /\]\(([^)\s]+\.md)(?:#[^)\s]*)?(?:\s+"[^"]*")?\)|\[\[([^\]#]+\.md)(?:#[^\]]*)?\]\]|^\[[^\]]+\]:\s*(\S+\.md)(?:#\S*)?/gu

function readBindings(meta: MetaStore): Map<string, Binding> {
  const data = meta.readJson<{ version?: unknown; bindings?: unknown }>(filename)
  const bindings = new Map<string, Binding>()
  if (
    data?.version !== 1 ||
    !data.bindings ||
    typeof data.bindings !== 'object' ||
    Array.isArray(data.bindings)
  )
    return bindings
  for (const [key, value] of Object.entries(data.bindings)) {
    if (
      !digest.test(key) ||
      !value ||
      typeof value.topic !== 'string' ||
      typeof value.topicHash !== 'string' ||
      !digest.test(value.topicHash)
    )
      return new Map()
    bindings.set(key, { topic: value.topic, topicHash: value.topicHash })
  }
  return bindings
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
  if (ctx.layer !== 'workspace' || committed.path !== 'MEMORY.md') return
  const before = new Set(Array.from(summaries(intent.before.content), (line) => line.text))
  const after = [...summaries(committed.content)]
  const previous = readBindings(ctx.meta)
  const unchanged = new Set(after.filter((line) => before.has(line.text)).map((line) => line.key))
  const files = new Map(ctx.files.map((entry) => [entry.path, entry]))
  const bindings = new Map<string, Binding>()
  for (const { key, topics } of after) {
    // A v1 binding vouches for one topic. A line referring to several must fail closed.
    if (topics.size !== 1) continue
    const [topic] = topics
    const target = files.get(topic!)
    if (unchanged.has(key)) {
      const binding = previous.get(key)
      if (binding) bindings.set(key, binding)
    } else if (target?.bytes) {
      bindings.set(key, { topic: target.path, topicHash: target.hash })
    }
  }
  if (bindings.size || previous.size)
    ctx.meta.writeJson(filename, { version: 1, bindings: Object.fromEntries(bindings) })
}

export const topicLinksViewFilter: ViewFilter = (entry, ctx) => {
  if (ctx.layer !== 'workspace' || entry.path !== 'MEMORY.md') return []
  const lines = [...summaries(entry.content)]
  if (!lines.length) return []
  const bindings = readBindings(ctx.meta)
  const files = new Map(ctx.files.map((file) => [file.path, file]))
  const ranges: HideRange[] = []
  for (const { key, topics, start, end } of lines) {
    const binding = bindings.get(key)
    for (const topic of topics) {
      const target = files.get(topic)
      if (target?.bytes && binding?.topic === topic && binding.topicHash === target.hash) continue
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
