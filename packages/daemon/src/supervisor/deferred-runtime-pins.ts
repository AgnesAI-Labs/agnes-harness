import type { RuntimePinsAdapter } from '@agnes/daemon/packages'

/** Preserve the refusal result until the supervisor installs its private pin adapter. */
export function deferredRuntimePins(read: () => RuntimePinsAdapter | undefined): RuntimePinsAdapter {
  return {
    async inspect(profileName) {
      return (
        read()?.inspect(profileName) ?? {
          error: {
            code: 'E_PACKAGE_STATE',
            safeMessage: 'Package state does not allow this action.',
            blockers: [],
          },
        }
      )
    },
    async release(profileName, pinIds) {
      return (
        read()?.release(profileName, pinIds) ?? {
          error: {
            code: 'E_PACKAGE_STATE',
            safeMessage: 'Package state does not allow this action.',
            blockers: [],
          },
        }
      )
    },
  }
}
