import type { CredentialStoreReason } from './adapters/credential-files.js'

export type CredentialDiagnostic = {
  part: 'home' | 'secrets' | 'auth' | 'locks' | 'store'
  check: CredentialStoreReason
  mode?: string
  expectedMode?: string
}

/** Fixed setup failures exposed to the local configuration RPC.  Messages never contain input. */
export const CONFIGURATION_ERROR_CODES = [
  'CONFIG_INVALID_INPUT',
  'CONFIG_UNKNOWN_PROVIDER',
  'CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED',
  'CONFIG_CREDENTIAL_REQUIRED',
  'CONFIG_CREDENTIAL_REJECTED',
  'CONFIG_CREDENTIAL_STORE',
  'CONFIG_CREDENTIAL_PERMISSIONS',
  'CONFIG_CREDENTIAL_READ_ONLY',
  'CONFIG_CREDENTIAL_NO_SPACE',
  'CONFIG_CREDENTIAL_INVALID',
  'CONFIG_PROVIDER_UNAVAILABLE',
  'CONFIG_TEST_FAILED',
  'CONFIG_SUBSCRIPTION_AUTH',
  'CONFIG_SUBSCRIPTION_QUOTA',
  'CONFIG_SUBSCRIPTION_RATE_LIMIT',
  'CONFIG_SUBSCRIPTION_TIMEOUT',
  'CONFIG_SUBSCRIPTION_MODEL',
  'CONFIG_SUBSCRIPTION_FAILED',
  'CONFIG_MODEL_UNAVAILABLE',
  'CONFIG_CHAT_MODEL_REQUIRED',
  'CONFIG_REVISION_CONFLICT',
  'CONFIG_PERSIST_FAILED',
  'CONFIG_INVALID_STATE',
] as const
export type ConfigurationErrorCode = (typeof CONFIGURATION_ERROR_CODES)[number]

/** `file` is the authority file a CONFIG_INVALID_STATE came from: it fails closed and is left as found. */
export class ConfigurationError extends Error {
  constructor(
    readonly code: ConfigurationErrorCode,
    readonly file?: string,
    readonly credential?: CredentialDiagnostic,
    readonly field?: 'baseUrl' | 'apiKey' | 'credentialRef',
  ) {
    super(
      code === 'CONFIG_CREDENTIAL_NO_SPACE'
        ? 'Credential storage has no free space. Free disk space in AGH_HOME and retry.'
        : code === 'CONFIG_CREDENTIAL_PERMISSIONS'
          ? 'Credential permissions are invalid. Check ownership, directory mode 0700 and file mode 0600; see data/audit/configuration.jsonl.'
          : code === 'CONFIG_CREDENTIAL_READ_ONLY'
            ? 'Credential storage is read-only. Move AGH_HOME to a writable local directory and restart.'
            : code === 'CONFIG_CREDENTIAL_INVALID'
              ? 'Credential storage is unsafe or invalid. Check data/audit/configuration.jsonl.'
              : code === 'CONFIG_CREDENTIAL_REJECTED'
                ? 'The provider rejected the API key or its access. Check the key and account permissions.'
                : code.startsWith('CONFIG_SUBSCRIPTION_')
                  ? 'Subscription model test failed.'
                  : code === 'CONFIG_INVALID_INPUT'
                    ? 'Configuration input is invalid.'
                    : code === 'CONFIG_UNKNOWN_PROVIDER'
                      ? 'The selected provider is unavailable.'
                      : code === 'CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED'
                        ? 'This provider does not support endpoint overrides.'
                        : code === 'CONFIG_CREDENTIAL_REQUIRED'
                          ? 'An API key is required.'
                          : code === 'CONFIG_CREDENTIAL_STORE'
                            ? 'The credential store is unavailable.'
                            : code === 'CONFIG_PROVIDER_UNAVAILABLE'
                              ? 'The provider catalogue is unavailable.'
                              : code === 'CONFIG_TEST_FAILED'
                                ? 'The provider connection test failed.'
                                : code === 'CONFIG_CHAT_MODEL_REQUIRED'
                                  ? 'Image and video generation models cannot be used for chat. Choose a chat model.'
                                  : code === 'CONFIG_MODEL_UNAVAILABLE'
                                    ? 'The selected model is unavailable.'
                                    : code === 'CONFIG_REVISION_CONFLICT'
                                      ? 'Configuration changed; reload and try again.'
                                      : code === 'CONFIG_PERSIST_FAILED'
                                        ? 'Configuration could not be saved.'
                                        : 'The saved configuration is invalid.',
    )
    this.name = 'ConfigurationError'
    if (field) this.message = `${field}: ${this.message}`
    if (code === 'CONFIG_INVALID_STATE' && file)
      this.message = `The saved configuration file ${file} is invalid. It was left unchanged; repair it or move it aside, then restart.`
  }
}
