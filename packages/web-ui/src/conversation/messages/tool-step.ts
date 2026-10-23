import type { Translate } from '../../locales/index.js'
import { baseToolTitle } from '../../tool-presentation.js'
import type { ToolNode } from './context.js'

/** What a step did, in the reader's terms. It names the row and counts toward the group summary. */
export type ActivityKind =
  | 'command'
  | 'read'
  | 'search'
  | 'edit'
  | 'list'
  | 'web'
  | 'tool'
  | 'thinking'
  | 'approval'
  | 'step'

// Order is priority: a name such as `web_search` is the web, `read_file` is a read.
const KIND_BY_NAME: readonly (readonly [RegExp, ActivityKind])[] = [
  [/(web|http|url|browse|scrape|download)/i, 'web'],
  [/(shell|bash|exec|command|terminal)/i, 'command'],
  [/(search|grep|find|query|lookup)/i, 'search'],
  [/(read|cat|view|load|open_file|fetch_file)/i, 'read'],
  [/(write|edit|create|update|patch|replace|apply)/i, 'edit'],
  // Only a directory listing: `job_list` or `schedule_list` list something else.
  [/^(ls|dir|glob|walk|tree)$|^list_(dir|directory|files?)$|_(ls|glob|tree)$/i, 'list'],
]

export function toolKind(name: string): ActivityKind {
  for (const [pattern, kind] of KIND_BY_NAME) if (pattern.test(name)) return kind
  return 'tool'
}

// Which argument says what the step acted on, most telling first.
const TARGET_KEYS: Record<ActivityKind, readonly string[]> = {
  command: ['description', 'title'],
  read: ['path', 'file_path', 'filePath', 'file', 'filename', 'uri'],
  edit: ['path', 'file_path', 'filePath', 'file', 'filename'],
  list: ['path', 'dir', 'directory', 'pattern'],
  search: ['pattern', 'query', 'queries', 'q', 'regex', 'name', 'path'],
  web: ['url', 'query', 'queries', 'q'],
  tool: ['description', 'title', 'path', 'object', 'scope'],
  thinking: [],
  approval: [],
  step: [],
}

const HOME = /^(?:\/Users|\/home)\/[^/\s]+(?=\/|$)|^[A-Za-z]:\\Users\\[^\\\s]+(?=\\|$)/

/** A path under the reader's home reads from `~`; anything else is left as written. */
export const shortenHome = (text: string): string => text.replace(HOME, '~')

const firstLine = (text: string): string => {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function argument(preview: string | undefined, keys: readonly string[]): string | undefined {
  if (!preview) return undefined
  let args: unknown
  try {
    args = JSON.parse(preview)
  } catch {
    args = undefined
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const record = args as Record<string, unknown>
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value
      if (typeof value === 'number') return String(value)
      if (Array.isArray(value)) {
        const texts = value.filter((item): item is string => typeof item === 'string' && !!item.trim())
        if (texts.length) return texts.join(' · ')
      }
    }
    return undefined
  }
  // The preview is clipped JSON for a long call: read the wanted string straight from the text.
  for (const key of keys) {
    const found = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(preview)
    if (!found?.[1]) continue
    try {
      return JSON.parse(`"${found[1].replace(/\\$/, '')}"`) as string
    } catch {
      return found[1]
    }
  }
  return undefined
}

export interface ToolStep {
  kind: ActivityKind
  /** Run command / read / search / edit / call <tool>. */
  verb: string
  /** One line: what it acted on. Empty when the call names nothing. */
  target: string
  /** The untruncated target, for the tooltip. */
  full: string
  /** The command line itself, when the call ran one. */
  mono?: boolean
  command?: string
}

/** Names one tool call as a step: a verb for its kind and the one thing it acted on. */
export function toolStep(node: ToolNode, t: Translate, presentation?: { name: string }): ToolStep {
  if (node.presentation) {
    const view = node.presentation
    const scope = argument(node.argsPreview, ['path', 'file_path', 'object', 'batch', 'scope'])
    const target = [...new Set([scope, view.summary, view.description].filter(Boolean))].join(' · ')
    const command =
      toolKind(node.name) === 'command' ? argument(node.argsPreview, ['command', 'cmd', 'script']) : undefined
    return {
      kind: 'tool',
      verb: baseToolTitle(node.name, t) ?? view.title,
      target,
      full: target,
      ...(command ? { command } : {}),
    }
  }
  if (presentation)
    return { kind: 'tool', verb: baseToolTitle(node.name, t) ?? presentation.name, target: '', full: '' }
  const kind = toolKind(node.name)
  const raw = argument(node.argsPreview, TARGET_KEYS[kind]) ?? ''
  const full =
    kind === 'command' || kind === 'search' || kind === 'web' ? raw.trim() : shortenHome(raw.trim())
  const command = kind === 'command' ? argument(node.argsPreview, ['command', 'cmd', 'script']) : undefined
  return {
    ...(command ? { command } : {}),
    kind,
    mono: ['read', 'edit', 'list'].includes(kind) && Boolean(full),
    verb:
      baseToolTitle(node.name, t) ??
      (kind === 'tool'
        ? t('activity.verb.generic')
        : kind === 'web' && /search/i.test(node.name)
          ? t('activity.verb.webSearch')
          : t(`activity.verb.${kind}`)),
    target: firstLine(full),
    full,
  }
}

/** The first line of a thought names its row; while it is being written the newest line does. */
export function thoughtLine(text: string, streaming = false): string {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .filter(Boolean)
  return (streaming ? lines.at(-1) : lines[0]) ?? ''
}

const SUMMARY_ORDER: readonly ActivityKind[] = [
  'read',
  'search',
  'list',
  'command',
  'edit',
  'web',
  'step',
  'tool',
  'approval',
]

/** Read 3 files, ran 2 commands — a group of consecutive steps in one line. */
export function activitySummary(kinds: readonly ActivityKind[], t: Translate): string {
  const counts = new Map<ActivityKind, number>()
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  // Thinking is named only when nothing else happened: it accompanies every other step.
  const shown = SUMMARY_ORDER.filter((kind) => counts.has(kind))
  if (shown.length === 0) return counts.has('thinking') ? t('activity.summary.thinking') : ''
  // Keep the order things first happened in, so the line reads like the work did.
  shown.sort((a, b) => kinds.indexOf(a) - kinds.indexOf(b))
  const parts = shown.map((kind) => {
    const n = counts.get(kind) ?? 0
    return n === 1 ? t(`activity.summary.${kind}.one`) : t(`activity.summary.${kind}.many`, { n })
  })
  const [first = '', ...rest] = parts
  // English lowercases what follows the first clause; CJK has no case and is left untouched.
  return [first, ...rest.map((part) => part.charAt(0).toLowerCase() + part.slice(1))].join(
    t('activity.summary.joiner'),
  )
}
