import type { ConfigAccount } from '@agnes/protocol'
import { isSubscriptionCredential, type StoredCredential } from './adapters/credential-store.js'
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
