import { getApiKeyProvider, validateModelBaseUrl } from '@agnes/ai'
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

/** Saved destinations never inherit credentials without an explicit choice by the caller. */
export function requireEndpointCredential(
  baseUrl: string,
  row: { baseUrl: string; id: string } | undefined,
  parsed: { apiKey?: string; credentialRef?: string },
): void {
  if (
    row &&
    baseUrl.replace(/\/$/, '') !== row.baseUrl.replace(/\/$/, '') &&
    parsed.apiKey === undefined &&
    parsed.credentialRef === undefined
  )
    throw new ConfigurationError(
      'CONFIG_CREDENTIAL_REQUIRED',
      undefined,
      undefined,
      getApiKeyProvider(row.id)?.capabilities?.payloadOnly === true ? 'credentialRef' : 'apiKey',
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
