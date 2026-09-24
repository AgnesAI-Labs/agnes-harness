/**
 * Compatibility entry point for the settings region.
 *
 * Settings rendering belongs to `@agnes/web-units`; this module remains so
 * existing Web tests and controllers can keep their established import path.
 */

export type {
  SettingsPane,
  SettingsPaneChange,
  SettingsRegionHandle,
  SettingsRegionOptions,
  SettingsResourceTab,
} from '@agnes/web-units'
export {
  PANE_IDS,
  renderSettingsMarkup,
  SettingsBuiltin,
  SettingsPaneBuiltin,
  settingsPaneSlotHostId,
} from '@agnes/web-units'
