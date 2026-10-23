import {
  SchemeThumbnail,
  SettingsBlock,
  SettingsChoice,
  SettingsInfo,
  SettingsItem,
  SettingsOptionSelect,
  SettingsPageHeader,
  SettingsSubpageFrame,
  SettingsUndoScope,
  StateSwitch,
  setAdvancedSettingsShown,
  useAdvancedSettings,
} from '@agnes/web-ui'
import type { ReactNode } from 'react'
import type { SettingsPane } from './settings.js'
import { SettingsDshHost } from './settings-shell.js'

/** The General pane; its controller owns the palette, skin, font size and language values. */
export function SettingsStaticPane({
  pane,
  translate,
  extras,
}: {
  pane: SettingsPane
  translate?: (key: string) => string
  /** Groups the host adds between the appearance settings and the advanced switch. */
  extras?: ReactNode
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
      <SettingsUndoScope>
        <SettingsSubpageFrame
          routeId="general"
          // The page's title is the breadcrumb's top level: 「General › Memory files」.
          rootTitle={text('settings-shell.appearanceTitle', '通用')}
          header={
            <SettingsPageHeader
              className="agnes-settings-page-top"
              title={<span>{text('settings-shell.appearanceTitle', '通用')}</span>}
            />
          }
        >
          <div className="config-workspace">
            <SettingsDshHost name="settings.general.item" />
            {/* One row per setting: name left, control right. Skins and languages are lists read
             at run time, so they are pickers. */}
            <SettingsBlock
              label={
                <>
                  {text('settings-shell.appearanceGroup', '外观')}
                  <SettingsInfo
                    text={text('settings-shell.appearanceIntro', '界面外观和语言；只保存在这台电脑上。')}
                  />
                </>
              }
              className="appearance-group"
            >
              <SettingsItem label={text('settings-shell.palette', '配色')}>
                <fieldset
                  className="appearance-thumbs agnes-settings-fieldset"
                  aria-label={text('settings-shell.palette', '配色')}
                >
                  <SettingsChoice
                    type="radio"
                    name="agnes-theme"
                    value="system"
                    preview={<SchemeThumbnail scheme="system" />}
                    label={<span>{text('settings-shell.paletteSystem', '跟随系统')}</span>}
                  />
                  <SettingsChoice
                    type="radio"
                    name="agnes-theme"
                    value="light"
                    preview={<SchemeThumbnail scheme="light" />}
                    label={<span>{text('settings-shell.paletteLight', '浅色')}</span>}
                  />
                  <SettingsChoice
                    type="radio"
                    name="agnes-theme"
                    value="dark"
                    preview={<SchemeThumbnail scheme="dark" />}
                    label={<span>{text('settings-shell.paletteDark', '深色')}</span>}
                  />
                </fieldset>
              </SettingsItem>
              <SettingsItem label={text('settings-shell.skin', '皮肤')} labelId="skin-select-label">
                <span className="appearance-picker">
                  <SettingsOptionSelect id="skin-select" aria-labelledby="skin-select-label" />
                  <span id="skin-option-items" />
                </span>
              </SettingsItem>
              <SettingsItem label={text('settings-shell.fontScale', '字号')}>
                <div id="font-scale-choices" />
              </SettingsItem>
              <SettingsItem
                label={text('settings.appearance.language', '语言')}
                labelId="locale-select-label"
              >
                <span className="appearance-picker">
                  <SettingsOptionSelect id="locale-select" aria-labelledby="locale-select-label" />
                </span>
              </SettingsItem>
            </SettingsBlock>
            {extras}
            <SettingsBlock>
              <SettingsItem
                label={<span>{text('settings-shell.showAdvanced', '显示高级设置')}</span>}
                info={text('settings-shell.showAdvancedHelp', '运行配置、诊断和各页里的高级选项。')}
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
            </SettingsBlock>
          </div>
        </SettingsSubpageFrame>
      </SettingsUndoScope>
    </section>
  )
}
