import { HostError } from '@agnes/host-common/errors'
import {
  ConfigurationError,
  type SessionDefaultsConfigurationService,
} from '@agnes/host-infrastructure/configuration'
import { defaultLoop, type LoopSelection, parseLoopSelection } from '@agnes/protocol'

/** Admin defaults share the configuration service's validation and live persisted state. */
export async function readAdminLoopDefault(
  configuration: Pick<SessionDefaultsConfigurationService, 'sessionDefaults'>,
): Promise<LoopSelection | undefined> {
  try {
    const { defaults } = await configuration.sessionDefaults()
    const loop = defaultLoop(defaults)
    return loop === undefined ? undefined : parseLoopSelection(loop)
  } catch (error) {
    if (error instanceof ConfigurationError && error.code === 'CONFIG_INVALID_STATE')
      throw new HostError(
        'E_PRESET_UNSUPPORTED',
        `invalid persisted session loop default${error.file ? ` in ${error.file}` : ''}`,
      )
    throw error
  }
}
