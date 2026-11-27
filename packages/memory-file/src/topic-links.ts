import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryFile } from '@agnes/extension-api'
import { hash } from './content.js'
import type { MetaStore } from './meta.js'
import { parseParagraphs } from './paragraphs.js'
import { isMemoryName } from './paths.js'
import type { CommitObserver, ViewFilter } from './pipeline.js'
import type { HideRange } from './view.js'

type Binding = Readonly<{ topic: string; topicHash: string }>
type LinkState = Readonly<{ status: 'missing' | 'valid' | 'corrupt'; bindings: Map<string, Binding> }>
const filename = 'links.json'
const digest = /^[0-9a-f]{64}$/u
const destination = /(?:<([^<>\s#]+\.md)(?:#[^<>\s]*)?>|([^()<>\s#]+\.md)(?:#[^()\s]*)?)/u.source
const padding = /[ \t]*(?:\r?\n[ \t]*)?/u.source
const titleBody = (delim: string) => `(?:[^${delim}\\\\\\r\\n]|\\\\.|\\r?\\n(?![ \\t]*\\r?\\n))*`
const title = `(?:(?:[ \\t]+|[ \\t]*\\r?\\n[ \\t]*)(?:"${titleBody('"')}"|'${titleBody("'")}'|\\(${titleBody('()')}\\)))?`
const inline = String.raw`\]\(${padding}${destination}${title}${padding}\)`
const wiki = /\[\[([^\]#|\n]+\.md)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/u.source
const definition = String.raw`^(?: {0,3}>[ \t]?)* {0,3}\[[^\]\n]+\]:\s*${destination}(?=\s|$)`
const links = new RegExp([inline, wiki, definition].join('|'), 'gimu')

export function* topicLinks(content: string, firstLine = true) {
  const offset = firstLine && content.startsWith('\uFEFF') ? 1 : 0
  for (const match of content.slice(offset).matchAll(links)) {
    const target = match.slice(1).find((capture) => capture !== undefined)!
    yield {
      target: target.replace(/^\.\//u, ''),
      start: offset + match.index,
      end: offset + match.index + match[0].length,
    }
  }
}

/** Match an alternate case only when the filesystem resolves it to the listed file. */
export function resolveTopic(root: string, target: string, files: ReadonlyMap<string, MemoryFile>) {
  const exact = files.get(target)
  if (exact || !isMemoryName(target.toLowerCase())) return exact
  const spelling = [...files.keys()].find((leaf) => leaf.toLowerCase() === target.toLowerCase())
  if (!spelling) return undefined
  const requested = lstatSync(join(root, target), { bigint: true, throwIfNoEntry: false })
  const listed = lstatSync(join(root, spelling), { bigint: true, throwIfNoEntry: false })
  return requested && listed && requested.dev === listed.dev && requested.ino === listed.ino
    ? files.get(spelling)
    : undefined
}

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
    for (const { target } of topicLinks(text, line.index === 0)) topics.add(target)
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
    const target = resolveTopic(ctx.meta.store.root, topic!, files)
    const inManaged = managed.some((span) => start >= span.start && end <= span.end)
    const existing = previous.get(key)
    // Preserve any existing binding (including stale ones) when an unrelated line changes so a
    // stale summary is never silently refreshed. A human saving MEMORY.md can bind a never-bound
    // ordinary summary line (e.g. upgraded from before links.json existed).
    if (unchanged.has(key) && (existing !== undefined || intent.origin !== 'human' || inManaged)) {
      if (existing) bindings.set(key, existing)
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
      const target = resolveTopic(ctx.meta.store.root, topic, files)
      if (target?.bytes && binding?.topic === target.path && binding.topicHash === target.hash) continue
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
