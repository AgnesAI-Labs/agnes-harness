import type { ToolDef } from '@agnes/extension-api'
import { modelVisibleTool } from '../step/model-tools.js'
import type { PromptSection } from './contribute.js'

const encoder = new TextEncoder()
const MAX_BYTES = 8192
const DESCRIPTION_MAX = 250
const PREFIX =
  'Deferred tools are available by discovery. Use tool_search to find a capability, then tool_describe to load its schema for subsequent requests. Discovery grants no execution permission.\n<available_deferred_tools>\n'
const SUFFIX = '</available_deferred_tools>'
const bytes = (text: string) => encoder.encode(text).byteLength

function sentence(description: string): string {
  const flat = description.replace(/\s+/gu, ' ').trim()
  const first = flat.match(/^.*?[.!?。！？](?:\s|$)/u)?.[0].trim() ?? flat
  const chars = [...first]
  return chars.length > DESCRIPTION_MAX
    ? `${chars
        .slice(0, DESCRIPTION_MAX - 1)
        .join('')
        .trimEnd()}…`
    : first || '-'
}

/** Names shown on a group line before the rest are only counted. */
const GROUP_SAMPLE = 6

/**
 * One line per group: its label, how many tools it holds and a few of their names, which is enough
 * for the model to know what to search for without paying for every tool's line.
 */
function groupLine(label: string, names: readonly string[]): { name: string; description: string } {
  const sample = names.slice(0, GROUP_SAMPLE).join(', ')
  const more = names.length > GROUP_SAMPLE ? `, … ${names.length - GROUP_SAMPLE} more` : ''
  return {
    name: label,
    description: `${names.length} ${names.length === 1 ? 'tool' : 'tools'} (${sample}${more}); search by task or by "${label}"`,
  }
}

/** Live turn catalog, including loaded deferred tools so discovery does not churn the cached prefix. */
export function deferredToolsSection(defs: readonly ToolDef[]): PromptSection | undefined {
  const deferred = defs.filter((tool) => tool.meta.deferLoading === true && modelVisibleTool(tool, true))
  const groups = new Map<string, string[]>()
  for (const tool of deferred) {
    const label = tool.meta.discoveryGroup
    if (label === undefined) continue
    const names = groups.get(label) ?? []
    names.push(tool.name)
    groups.set(label, names)
  }
  const rows = [
    ...deferred
      .filter((tool) => tool.meta.discoveryGroup === undefined)
      .map((tool) => ({ name: tool.name, description: sentence(tool.description) })),
    ...[...groups].map(([label, names]) => groupLine(label, names.sort())),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (!rows.length) return undefined
  const lines: string[] = []
  let size = bytes(PREFIX + SUFFIX)
  for (const row of rows) {
    const line = `${row.name} — ${row.description}\n`
    if (size + bytes(line) > MAX_BYTES) break
    lines.push(line)
    size += bytes(line)
  }
  let note = ''
  while (lines.length < rows.length) {
    note = `omitted ${rows.length - lines.length} deferred tools; use tool_search\n`
    if (size + bytes(note) <= MAX_BYTES) break
    const removed = lines.pop()
    if (removed === undefined) throw new Error('Deferred tool catalog header exceeds its budget')
    size -= bytes(removed)
  }
  return {
    id: 'core:deferred-tools',
    order: 155,
    source: 'core',
    text: PREFIX + lines.join('') + note + SUFFIX,
  }
}
