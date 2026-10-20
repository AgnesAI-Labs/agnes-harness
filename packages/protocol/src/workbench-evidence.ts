import { type Static, Type } from '@sinclair/typebox'
import { validateAgainst } from './validate.js'

/** Display objects in structured.evidence; paths always use the session workspace reader. */
export const WorkbenchEvidenceItem = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    kind: Type.Union([Type.Literal('report'), Type.Literal('file'), Type.Literal('record')]),
    status: Type.Union([Type.Literal('available'), Type.Literal('pending'), Type.Literal('failed')]),
    path: Type.String({
      minLength: 1,
      maxLength: 4096,
      pattern: '^(?![a-zA-Z][a-zA-Z0-9+.-]*:)[^\\u0000-\\u001f]+$',
    }),
  },
  { additionalProperties: false },
)
export type WorkbenchEvidenceItem = Static<typeof WorkbenchEvidenceItem>

/** Invalid declarations are ignored independently; unrelated tool executions are never evidence. */
export function readWorkbenchEvidence(value: unknown): WorkbenchEvidenceItem[] {
  if (!value || typeof value !== 'object' || !('evidence' in value) || !Array.isArray(value.evidence))
    return []
  return value.evidence.slice(0, 64).flatMap((item) => {
    const result = validateAgainst<WorkbenchEvidenceItem>(WorkbenchEvidenceItem, item)
    return result.ok ? [result.value] : []
  })
}
