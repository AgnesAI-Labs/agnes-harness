import { Icon } from './ui/icon.js'
import { type IconName, icons } from './ui/icons.js'

const navigation: Readonly<Record<string, IconName>> = {
  accounts: 'list',
  agent: 'bot',
  plugins: 'plug',
  tools: 'sliders-horizontal',
  diagnostics: 'activity',
  automation: 'clock',
  security: 'shield-check',
  history: 'history',
  general: 'settings',
}
/** Which glyph a settings category or icon name is drawn with; unknown names read as a plugin. */
export const settingsIconName = (icon: string): IconName =>
  navigation[icon] ?? (Object.hasOwn(icons, icon) ? (icon as IconName) : 'plug')

/** The icon of a settings category, drawn by the shared Icon so it keeps its geometry and skin hook. */
export function SettingsIcon({ icon }: { icon: string }) {
  return <Icon name={settingsIconName(icon)} size={20} />
}
