import {
  SchemeThumbnail,
  SettingsChoice,
  SettingsGroup,
  SettingsItem,
  SettingsOptionSelect,
  SettingsPageHeader,
  StateSwitch,
  setAdvancedSettingsShown,
  useAdvancedSettings,
} from '@agnes/web-ui'
import type { SettingsPane } from './settings.js'
import { SettingsDshHost } from './settings-shell.js'

/** The General pane; its controller owns the palette, skin, font size and language values. */
export function SettingsStaticPane({
  pane,
  translate,
}: {
  pane: SettingsPane
  translate?: (key: string) => string
}) {
  const advanced = useAdvancedSettings()
  const text = (key: string, fallback: string) => {
    const value = translate?.(key) ?? key
    return value === key ? fallback : value
  }
  // The model pane is a component of its own; this is the one static pane left.
  if (pane !== 'appearance') return null
  return (
    <section
      id="appearance-settings-pane"
      className="settings-content agnes-settings-page"
      data-agnes-region="settings-pane"
      hidden
    >
      <SettingsPageHeader
        title={<span>{text('settings-shell.appearanceTitle', '通用')}</span>}
        description={
          <span>{text('settings-shell.appearanceIntro', '界面外观和语言；只保存在这台电脑上。')}</span>
        }
      />
      <div className="config-workspace">
        <SettingsDshHost name="settings.general.item" />
        {/* Each setting is one row: its name on the left, its control on the right. Skins and
         languages are lists read at run time, so they are pickers, not fixed segments. */}
        <fieldset
          className="appearance-options appearance-schemes"
          aria-label={text('settings-shell.palette', '配色')}
        >
          <legend>{text('settings-shell.palette', '配色')}</legend>
          <div className="appearance-thumbs">
            <SettingsChoice
              type="radio"
              name="agnes-theme"
              value="system"
              preview={<SchemeThumbnail scheme="system" />}
              label={<span>{text('settings-shell.paletteSystem', '跟随系统')}</span>}
              hint={<span>{text('settings-shell.paletteSystemHint', '随操作系统的深浅色设置自动切换')}</span>}
            />
            <SettingsChoice
              type="radio"
              name="agnes-theme"
              value="light"
              preview={<SchemeThumbnail scheme="light" />}
              label={<span>{text('settings-shell.paletteLight', '浅色')}</span>}
              hint={<span>{text('settings-shell.paletteLightHint', '始终使用浅色界面')}</span>}
            />
            <SettingsChoice
              type="radio"
              name="agnes-theme"
              value="dark"
              preview={<SchemeThumbnail scheme="dark" />}
              label={<span>{text('settings-shell.paletteDark', '深色')}</span>}
              hint={<span>{text('settings-shell.paletteDarkHint', '始终使用深色界面')}</span>}
            />
          </div>
        </fieldset>
        <SettingsGroup className="appearance-group">
          <fieldset className="appearance-options" aria-label={text('settings-shell.skin', '皮肤')}>
            <legend>{text('settings-shell.skin', '皮肤')}</legend>
            <div className="appearance-picker">
              <SettingsOptionSelect id="skin-select" />
              <div id="skin-option-items" />
            </div>
          </fieldset>
          <fieldset className="appearance-options" aria-label={text('settings-shell.fontScale', '字号')}>
            <legend>{text('settings-shell.fontScale', '字号')}</legend>
            <div className="appearance-choices">
              <SettingsChoice
                type="radio"
                name="agnes-font-scale"
                value="small"
                label={<span>{text('settings-shell.fontSmall', '小')}</span>}
                hint={<span>{text('settings-shell.fontSmallHint', '界面整体缩小一档')}</span>}
              />
              <SettingsChoice
                type="radio"
                name="agnes-font-scale"
                value="normal"
                label={<span>{text('settings-shell.fontNormal', '标准')}</span>}
                hint={<span>{text('settings-shell.fontNormalHint', '默认字号')}</span>}
              />
              <SettingsChoice
                type="radio"
                name="agnes-font-scale"
                value="large"
                label={<span>{text('settings-shell.fontLarge', '大')}</span>}
                hint={<span>{text('settings-shell.fontLargeHint', '界面整体放大一档')}</span>}
              />
            </div>
          </fieldset>
          <fieldset className="appearance-options" aria-label={text('settings.appearance.language', '语言')}>
            <legend>{text('settings.appearance.language', '语言')}</legend>
            <div className="appearance-picker">
              <SettingsOptionSelect id="locale-select" />
            </div>
          </fieldset>
        </SettingsGroup>
        <SettingsGroup>
          <SettingsItem
            icon="sliders-horizontal"
            label={<span>{text('settings-shell.showAdvanced', '显示高级设置')}</span>}
            description={
              <span>{text('settings-shell.showAdvancedHelp', '运行配置、诊断和各页里的高级选项。')}</span>
            }
          >
            <StateSwitch
              id="settings-advanced-switch"
              testId="settings-advanced-switch"
              label={text('settings-shell.showAdvanced', '显示高级设置')}
              checked={advanced}
              disabled={false}
              onToggle={setAdvancedSettingsShown}
            />
          </SettingsItem>
        </SettingsGroup>
      </div>
    </section>
  )
}
