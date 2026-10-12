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

/** Live turn catalog, including loaded deferred tools so discovery does not churn the cached prefix. */
export function deferredToolsSection(defs: readonly ToolDef[]): PromptSection | undefined {
  const rows = defs
    .filter((tool) => tool.meta.deferLoading === true && modelVisibleTool(tool.name, true))
    .map((tool) => ({ name: tool.name, description: sentence(tool.description) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
