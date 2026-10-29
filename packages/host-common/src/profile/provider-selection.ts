import type { ProviderSelection } from '@agnes/extension-api'
import { HostError } from '../errors.js'

/** The provider kinds a profile selects beside the seven seam kinds. */
export const PROVIDER_KINDS = [
  'loop',
  'model-adapter',
  'compaction',
  'persistence',
  'sandbox',
  'tool-runtime',
  'tool-policy',
  'child-agent',
  'memory',
] as const
export type ProviderKindName = (typeof PROVIDER_KINDS)[number]

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** One selection spelling for every provider kind. */
export function readProviderSelection(kind: string, value: unknown): ProviderSelection | undefined {
  if (value === undefined) return undefined
  const input = record(value)
  if (
    !input ||
    typeof input.provider !== 'string' ||
    !input.provider.trim() ||
    (input.version !== undefined && (typeof input.version !== 'string' || !input.version.trim())) ||
    Object.keys(input).some((key) => !['provider', 'version'].includes(key))
  )
    throw new HostError('E_PROFILE_FRAGMENT_KEY', `${kind} requires { provider: id, version?: version }`)
  return Object.freeze({
    provider: input.provider,
    ...(input.version === undefined ? {} : { version: input.version as string }),
  })
}

/** Model transports may include several registrations or all registrations from a package. */
export type ModelAdapterSelection = { provider: string | readonly string[]; version?: string }
export function readModelAdapterSelection(value: unknown): ModelAdapterSelection | undefined {
  if (value === undefined) return undefined
  const input = record(value)
  if (!Array.isArray(input?.provider)) return readProviderSelection('model-adapter', value)
  const ids = input.provider
  if (
    ids.length > 256 ||
    ids.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(ids).size !== ids.length ||
    Object.keys(input).some((key) => !['provider', 'version'].includes(key)) ||
    (input.version !== undefined && (typeof input.version !== 'string' || !input.version.trim()))
  )
    throw new HostError(
      'E_PROFILE_FRAGMENT_KEY',
      'model-adapter requires { provider: id | unique ids, version?: version }',
    )
  return Object.freeze({
    provider: Object.freeze([...ids]),
    ...(input.version === undefined ? {} : { version: input.version as string }),
  })
}

export type ProviderSelections = Partial<
  Record<Exclude<ProviderKindName, 'model-adapter'>, ProviderSelection>
> & { 'model-adapter'?: ModelAdapterSelection }
