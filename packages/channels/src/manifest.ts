import { readFile } from 'node:fs/promises'
import { type ChannelManifest, validateChannelManifest } from '@agnes/protocol'
import { ChannelError } from './errors.js'

/** Validates both the generated schema and the relationships the schema cannot express. */
export function checkManifest(input: unknown): ChannelManifest {
  const result = validateChannelManifest(input)
  if (!result.ok) {
    const first = result.errors[0]
    throw new ChannelError(
      'E_MANIFEST_INVALID',
      `schema: ${first?.path ?? ''} ${first?.message ?? 'invalid'}`,
      { errors: result.errors },
    )
  }

  const manifest = result.value
  if (!manifest.connection.modes.includes(manifest.connection.default)) {
    throw new ChannelError(
      'E_MANIFEST_INVALID',
      `connection.default ${manifest.connection.default} not in modes ${manifest.connection.modes.join(',')}`,
    )
  }

  const overlap = manifest.credentials.required.filter((key) => manifest.credentials.optional.includes(key))
  if (overlap.length > 0) {
    throw new ChannelError(
      'E_MANIFEST_INVALID',
      `credentials required/optional overlap: ${overlap.join(',')}`,
    )
  }

  if (manifest.events.supported.includes('cardAction') && !manifest.capabilities.card) {
    throw new ChannelError(
      'E_MANIFEST_INVALID',
      'events.supported has cardAction but capabilities.card is false',
    )
  }
  return manifest
}

export async function loadManifest(path: string): Promise<ChannelManifest> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new ChannelError('E_MANIFEST_INVALID', `cannot read ${path}: ${errorName(error)}`)
  }

  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    throw new ChannelError('E_MANIFEST_INVALID', `${path} is not JSON: ${errorName(error)}`)
  }
  return checkManifest(input)
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error'
}
