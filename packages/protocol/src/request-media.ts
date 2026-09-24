import { type ValidationResult, validateAgainst } from '../../protocol-validation/src/validate.js'
import {
  type RequestMediaHeader,
  RequestMediaHeader as RequestMediaHeaderSchema,
  type RequestMediaManifestEntry,
} from '../gen/ts/session-v1.js'

export type ValidatedRequestMedia = Readonly<{
  media: RequestMediaHeader
  /** Entries in the persisted selection order, never a re-scan of the manifest. */
  selected: readonly RequestMediaManifestEntry[]
}>

const invalid = (
  path: string,
  message: string,
  code: 'RANGE' | 'OTHER' = 'OTHER',
): ValidationResult<never> => ({ ok: false, errors: [{ path, message, code }] })

/**
 * Validates the cross-field part of the durable request media contract and resolves its one selected
 * sequence. JSON Schema owns field types, bounds, closed objects and unique selection indexes; these
 * checks own relationships JSON Schema cannot express without a second, divergent manifest model.
 */
export function validateRequestMedia(value: unknown): ValidationResult<ValidatedRequestMedia> {
  const checked = validateAgainst<RequestMediaHeader>(RequestMediaHeaderSchema, value)
  if (!checked.ok) return checked
  const media = checked.value

  for (const [index, entry] of media.manifest.entries()) {
    if (entry.artifactUri.slice('artifact://'.length) !== entry.sha256)
      return invalid(`/manifest/${index}/artifactUri`, 'artifact URI digest does not match sha256')
    if (entry.selected && entry.reason !== undefined)
      return invalid(`/manifest/${index}/reason`, 'selected media cannot carry an omission reason')
    if (!entry.selected && entry.reason === undefined)
      return invalid(`/manifest/${index}/reason`, 'omitted media must carry an omission reason')
  }

  for (const [position, index] of media.selectionOrder.entries())
    if (index >= media.manifest.length)
      return invalid(`/selectionOrder/${position}`, 'selection index is outside the manifest', 'RANGE')

  const marked = media.manifest.flatMap((entry, index) => (entry.selected ? [index] : []))
  const ordered = new Set(media.selectionOrder)
  if (marked.length !== media.selectionOrder.length || marked.some((index) => !ordered.has(index)))
    return invalid('/selectionOrder', 'selection order must contain exactly the selected manifest indexes')

  if (media.route === 'text-only' && media.selectionOrder.length !== 0)
    return invalid('/route', 'text-only media route cannot select image bytes')

  return {
    ok: true,
    value: Object.freeze({
      media,
      selected: Object.freeze(
        media.selectionOrder.map((index) => media.manifest[index] as RequestMediaManifestEntry),
      ),
    }),
  }
}
