import { getApiKeyProvider, validateModelBaseUrl } from '@agnes/ai'
import { KEYLESS_CREDENTIAL } from './configuration-compatible.js'
import { ConfigurationError } from './configuration-error.js'

/** Structural parsing also reads saved records; adapter policy is checked on save and test only. */
export function parseBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigurationError('CONFIG_INVALID_INPUT', undefined, undefined, 'baseUrl')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname.length === 0 ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    url.hostname.includes('{') ||
    raw !== raw.trim()
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT', undefined, undefined, 'baseUrl')
  return raw
}

/**
 * Saved destinations never inherit credentials without an explicit choice by the caller. A keyless
 * compatible account stores only the placeholder, which has nothing to protect, so it may move.
 */
export async function requireEndpointCredential(
  baseUrl: string,
  row: { baseUrl: string; id: string; credentialRef: string } | undefined,
  parsed: { apiKey?: string; credentialRef?: string },
  read: (ref: string) => Promise<{ kind: string; provider: string; value?: string } | null>,
): Promise<void> {
  if (
    !row ||
    baseUrl.replace(/\/$/, '') === row.baseUrl.replace(/\/$/, '') ||
    parsed.apiKey !== undefined ||
    parsed.credentialRef !== undefined
  )
    return
  const entry = getApiKeyProvider(row.id)
  if (entry?.capabilities?.declaredModels === true) {
    const stored = await read(row.credentialRef)
    if (stored?.kind === 'api-key' && stored.provider === row.id && stored.value === KEYLESS_CREDENTIAL)
      return
  }
  throw new ConfigurationError(
    'CONFIG_CREDENTIAL_REQUIRED',
    undefined,
    undefined,
    entry?.capabilities?.payloadOnly === true ? 'credentialRef' : 'apiKey',
  )
}

export function validateEndpoint(entry: { api: string; route: string }, baseUrl: string): void {
  try {
    validateModelBaseUrl({ api: entry.api, route: entry.route, baseUrl })
  } catch {
    throw new ConfigurationError('CONFIG_INVALID_INPUT', undefined, undefined, 'baseUrl')
  }
}

/** An account's network timeouts: known keys only, each a whole number of milliseconds up to an hour. */
export function checkedNetworkTimeouts(
  value: unknown,
): NonNullable<import('@agnes/protocol').ConfigSaveInput['networkTimeouts']> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.entries(value).every(
      ([key, timeout]) =>
        ['requestMs', 'connectMs', 'streamIdleMs'].includes(key) &&
        typeof timeout === 'number' &&
        Number.isSafeInteger(timeout) &&
        timeout >= 1 &&
        timeout <= 3_600_000,
    )
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return value
}
