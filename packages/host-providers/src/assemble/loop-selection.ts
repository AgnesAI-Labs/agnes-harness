import { HostError } from '@agnes/host-common/errors'
import {
  ConfigurationError,
  type SessionDefaultsConfigurationService,
} from '@agnes/host-infrastructure/configuration'
import { type LoopSelection, parseLoopSelection } from '@agnes/protocol'

/** Admin defaults share the configuration service's validation and live persisted state. */
export async function readAdminLoopDefault(
  configuration: Pick<SessionDefaultsConfigurationService, 'sessionDefaults'>,
): Promise<LoopSelection | undefined> {
  try {
    const { defaults } = await configuration.sessionDefaults()
    return defaults.loop === undefined ? undefined : parseLoopSelection(defaults.loop)
  } catch (error) {
    if (error instanceof ConfigurationError && error.code === 'CONFIG_INVALID_STATE')
      throw new HostError('E_PRESET_UNSUPPORTED', 'invalid persisted session loop default')
    throw error
  }
}
