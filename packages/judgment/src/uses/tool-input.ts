import { redactSecrets } from '@agnes/extension-api'
import { object } from '../questions.js'

export type { BatchInput } from './batch-preparation.js'
export { BatchPreparationInterrupted, batchInput } from './batch-preparation.js'
export function findInput(value: unknown): { query: string; path?: string } | null {
  if (
    !object(value) ||
    typeof value.query !== 'string' ||
    !value.query.trim() ||
    value.query.length > 2000 ||
    (value.path !== undefined && (typeof value.path !== 'string' || !value.path || value.path.length > 2048))
  )
    return null
  return {
    query: redactSecrets(value.query),
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
  }
}
