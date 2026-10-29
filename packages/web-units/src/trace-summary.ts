import { approvalSummary, baseToolTitle, localizeToolSummary, webUiLocaleCatalog } from '@agnes/web-ui'
import { type TraceMessageKey, traceLocale, traceText } from './trace-locale.js'

const toolTranslate: import('@agnes/web-ui').Translate = (key, vars) =>
  (webUiLocaleCatalog[traceLocale()][key] ?? key).replace(/\{([^}]+)\}/g, (match, name: string) =>
    String(vars?.[name] ?? match),
  )
export const toolLabel = (name: string): string => baseToolTitle(name, toolTranslate) ?? name
export const traceApprovalSummary = (node: Extract<import('@agnes/protocol').UINode, { kind: 'approval' }>) =>
  approvalSummary(node, toolTranslate)

/** Argument previews are capped in length, so a long call arrives as unparseable JSON. */
const parse = (text: string | undefined): Record<string, unknown> | undefined => {
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
const escaped = (key: string) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const unquote = (value: string): string => {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value
  }
}
/** A string or number field, read from the parsed arguments or, when cut off, from the text. */
const field = (args: Record<string, unknown> | undefined, raw: string, key: string): string | undefined => {
  const value = args?.[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (args) return undefined
  const match = new RegExp(`"${escaped(key)}"\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|(-?\\d+))`).exec(raw)
  return match ? (match[1] !== undefined ? unquote(match[1]) : match[2]) : undefined
}
const allFields = (raw: string, key: string): string[] =>
  [...raw.matchAll(new RegExp(`"${escaped(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g'))].map((match) =>
    unquote(match[1] ?? ''),
  )
const fileName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
const oneLine = (value: string, max = 80): string => {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max).trimEnd()}…`
}
const count = (value: unknown): number | undefined =>
  Array.isArray(value)
    ? value.length
    : value && typeof value === 'object'
      ? Object.keys(value).length
      : undefined
const number = (value: number): string => value.toLocaleString(traceLocale())

export type ToolSummary = {
  /** What the call did, in words: «Read portal.html (first 80 lines)». */
  text: string
  /** The raw arguments, shown muted only when no readable summary exists. */
  secondary?: string
}

/** One tool call as a person would say it, from its name, argument preview and result preview. */
export function summarizeTool(input: {
  name: string
  presentation?: import('@agnes/protocol').ToolPresentation
  summary?: string | undefined
  argsPreview?: string | undefined
  resultPreview?: string | undefined
  status?: string | undefined
}): ToolSummary {
  if (input.presentation)
    return {
      text: [
        baseToolTitle(input.name, toolTranslate) ?? input.presentation.title,
        input.presentation.summary,
        input.presentation.description,
      ]
        .filter(Boolean)
        .join(' · '),
    }
  const raw = input.argsPreview ?? ''
  const args = parse(raw)
  const path = field(args, raw, 'path') ?? field(args, raw, 'file_path') ?? field(args, raw, 'file')
  const label = toolLabel(input.name)
  const say = (key: TraceMessageKey, vars: Record<string, string | number>): ToolSummary => ({
    text: traceText(key, { tool: label, ...vars }),
  })
  switch (input.name) {
    case 'read': {
      if (!path) break
      const limit = field(args, raw, 'limit')
      const offset = field(args, raw, 'offset')
      if (offset && limit)
        return say('trace.summary.readRange', {
          file: fileName(path),
          from: offset,
          to: Number(offset) + Number(limit) - 1,
        })
      if (limit) return say('trace.summary.readFirst', { file: fileName(path), n: limit })
      return say('trace.summary.file', { file: fileName(path) })
    }
    case 'write': {
      if (!path) break
      const content = args?.content
      return typeof content === 'string'
        ? say('trace.summary.write', { file: fileName(path), n: number(content.length) })
        : say('trace.summary.file', { file: fileName(path) })
    }
    case 'edit': {
      if (!path) break
      const edits = count(args?.edits)
      return edits
        ? say('trace.summary.edit', { file: fileName(path), n: edits })
        : say('trace.summary.file', { file: fileName(path) })
    }
    case 'shell':
    case 'bash': {
      const command = field(args, raw, 'description') ?? field(args, raw, 'title')
      if (command) return say('trace.summary.subject', { subject: oneLine(command) })
      break
    }
    case 'ls': {
      const target = path ?? '.'
      const lines =
        input.status === 'completed' && input.resultPreview
          ? input.resultPreview.split('\n').filter((line) => line.trim()).length
          : 0
      return lines > 1
        ? say('trace.summary.list', { subject: target, n: lines })
        : say('trace.summary.subject', { subject: target })
    }
    case 'grep':
    case 'find':
    case 'web_search': {
      const query = field(args, raw, 'pattern') ?? field(args, raw, 'query') ?? field(args, raw, 'glob')
      if (query) return say('trace.summary.quoted', { subject: oneLine(query, 60) })
      break
    }
    case 'web_fetch': {
      const url = field(args, raw, 'url')
      if (url) return say('trace.summary.subject', { subject: oneLine(url) })
      break
    }
    case 'ask_user_question': {
      const labels = Array.isArray(args?.questions)
        ? args.questions.flatMap((question) =>
            question && typeof question === 'object' && typeof question.label === 'string'
              ? [question.label as string]
              : [],
          )
        : allFields(raw, 'label')
      if (labels.length)
        return say('trace.summary.ask', {
          n: labels.length,
          labels: oneLine(labels.join(traceText('trace.join.items')), 60),
        })
      break
    }
    case 'ui_render':
    case 'ui_update': {
      const title = field(args, raw, 'title')
      if (title) return say('trace.summary.subject', { subject: oneLine(title, 60) })
      break
    }
    case 'ui_submit': {
      const answers = count(args?.answers)
      if (answers) return say('trace.summary.submit', { n: answers })
      break
    }
  }
  const described = input.summary && input.summary !== input.name ? input.summary : undefined
  return {
    text: described
      ? oneLine(localizeToolSummary(described, toolTranslate, input.name))
      : baseToolTitle(input.name, toolTranslate)
        ? label
        : traceText('trace.tool.generic'),
  }
}
