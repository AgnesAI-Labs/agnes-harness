import type { ConfigAccount } from '@agnes/protocol'
import {
  type CredentialStore,
  isSubscriptionCredential,
  type StoredCredential,
} from './adapters/credential-store.js'
import { configurationCredentialFailure } from './configuration-credential-failure.js'
import { ConfigurationError } from './configuration-error.js'

export const isUsableCredential = (value: string): boolean => /\P{C}/u.test(value.trim())

export function isConfiguredCredential(
  credential: StoredCredential | null,
  providerId: string,
  authType: 'api-key' | 'oauth',
  payloadOnly: boolean,
): boolean {
  if (!payloadOnly && authType === 'oauth') return isSubscriptionCredential(credential, providerId)
  return (
    credential?.kind === 'api-key' &&
    credential.provider === (payloadOnly ? 'generic' : providerId) &&
    isUsableCredential(credential.value)
  )
}

// Reads keep settings reachable. Mutations and connection tests retain their strict checks.
export async function configurationCredentialAvailability(
  check: () => Promise<boolean>,
): Promise<Pick<ConfigAccount, 'credentialConfigured' | 'credentialIssue'>> {
  try {
    return (await check())
      ? { credentialConfigured: true }
      : { credentialConfigured: false, credentialIssue: 'CONFIG_CREDENTIAL_REQUIRED' }
  } catch (error) {
    if (!(error instanceof ConfigurationError) || !error.code.startsWith('CONFIG_CREDENTIAL_')) throw error
    return { credentialConfigured: false, credentialIssue: 'CONFIG_CREDENTIAL_UNREADABLE' }
  }
}

/** Availability changes the effective default, never the persisted preference or existing pins. */
export function effectiveDefaultAccount(
  accounts: readonly ConfigAccount[],
  preferred: string | null,
  conversation: (account: ConfigAccount) => boolean,
): ConfigAccount | undefined {
  const usable = accounts.filter((row) => row.enabled && row.credentialConfigured && conversation(row))
  return usable.find((row) => row.accountId === preferred) ?? usable[0]
}

export function configurationCredentialReader(home: string, store: Pick<CredentialStore, 'read'>) {
  return async (ref: string): Promise<StoredCredential | null> => {
    try {
      return await store.read(ref)
    } catch (error) {
      throw configurationCredentialFailure(home, error, 'read')
    }
  }
}

/** These values stay in the local redactor; they are never projected onto the account RPC. */
export async function telemetryCredentialValues(
  accounts: readonly { credentialRef: string }[],
  read: (ref: string) => Promise<StoredCredential | null>,
): Promise<readonly string[]> {
  const credentials = await Promise.all(accounts.map((row) => read(row.credentialRef)))
  return credentials.flatMap((credential) => {
    if (!credential) return []
    if (credential.kind === 'api-key') return [credential.value]
    if (isSubscriptionCredential(credential))
      return [credential.access, credential.refresh, credential.accountId, credential.enterpriseUrl].filter(
        (value): value is string => typeof value === 'string',
      )
    return [credential.accessToken, credential.refreshToken, credential.grantId]
  })
}
