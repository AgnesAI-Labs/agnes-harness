import type { ToolPresentation } from '@agnes/protocol'

const LABELS: Record<string, string> = {
  shell: 'Run command',
  write: 'Write file',
  edit: 'Edit file',
  read: 'Read file',
}
const SCOPES = [
  'path',
  'file_path',
  'target',
  'object',
  'projectId',
  'gateId',
  'recordId',
  'artifactId',
  'id',
  'batch',
  'scope',
]

/** Display only: exact arguments stay in the decision subject and its authorization binding. */
export function summarizeCall(
  name: string,
  args: unknown,
  presentation?: ToolPresentation,
  description?: string,
): string {
  const input =
    args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  const scope = SCOPES.map((key) => input[key]).find((value) => typeof value === 'string' && value.trim())
  const purpose = typeof input.description === 'string' ? input.description : undefined
  const parts = presentation
    ? [presentation.title, scope, presentation.summary, presentation.description]
    : [LABELS[name] ?? description ?? name, scope, purpose]
  const text = [...new Set(parts.filter(Boolean))].join(' · ')
  if (text.length <= 2000) return text
  let end = 1999
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}
