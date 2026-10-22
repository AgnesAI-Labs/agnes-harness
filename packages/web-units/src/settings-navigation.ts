import { setDisclosureOpen } from '@agnes/web-ui'
import type { SettingsNavigationEntry } from './settings.js'

const merged: Readonly<Record<string, readonly [string, string]>> = {
  bundles: ['models', 'bundles'],
  'system-prompt': ['models', 'system-prompt'],
  context: ['models', 'context'],
  // Adding an account is a page of 模型与账户.
  'add-account': ['model', 'add-account'],
  // Subpages of 权限与安全 open from their rows.
  'auto-review': ['security', 'auto-review'],
  'approval-rules': ['security', 'approval-rules'],
  isolation: ['security', 'isolation'],
  // Subpages of 运行配置 open from their rows.
  'prompt-preview': ['models', 'prompt-preview'],
  'agent-fde': ['models', 'bundles'],
  'runtime-config': ['models', 'models'],
  'runtime-configuration': ['models', 'models'],
  'additional-combinations': ['models', 'bundles'],
  'session-slots': ['models', 'session-slots'],
  // The loop is chosen in 新会话默认 → 执行方式; memory and instructions are the General page's 个性化.
  execution: ['models', 'session-loop'],
  personalization: ['general', 'personalization'],
  memory: ['general', 'memory'],
  'custom-instructions': ['general', 'custom-instructions'],
  providers: ['diagnostics', 'runtime-details'],
  'runtime-details': ['diagnostics', 'runtime-details'],
  otlp: ['diagnostics', 'otlp'],
  errors: ['diagnostics', 'errors'],
  // Credentials are the lower half of the permissions page.
  credentials: ['security', 'credentials'],
}

/** Existing links keep their destination after sections are consolidated. */
export function settingsRoute(id: string): { id: string; anchor?: string; terminal?: boolean } {
  if (id === 'auxiliary-models') return { id: 'model', anchor: 'auxiliary-models' }
  if (id === 'terminal' || id === 'jobs') return { id: 'jobs', terminal: true }
  const target = merged[id]
  return target ? { id: target[0], anchor: `settings-subsection-${target[1]}` } : { id }
}

/** Where a page that left the settings dialog lives now. */
export type SettingsMoveTarget =
  | Readonly<{ kind: 'page'; page: 'agents' | 'plugins' | 'automation'; tab?: string }>
  | Readonly<{ kind: 'session-search' }>
  | Readonly<{ kind: 'archived-sessions' }>

/**
 * Pages that moved out of settings, by their old `?settings=<id>` value. The dialog no longer has
 * them: an old link, or a request for one by name, opens the new place instead.
 */
export const SETTINGS_MOVED: Readonly<Record<string, SettingsMoveTarget>> = {
  plugins: { kind: 'page', page: 'plugins' },
  discover: { kind: 'page', page: 'plugins', tab: 'market' },
  examples: { kind: 'page', page: 'agents' },
  skills: { kind: 'page', page: 'plugins', tab: 'skills' },
  feedback: { kind: 'page', page: 'plugins', tab: 'review' },
  mcp: { kind: 'page', page: 'plugins', tab: 'mcp' },
  // Web search, computer use and child agents are built-ins on the plugins page.
  'computer-use': { kind: 'page', page: 'plugins', tab: 'plugins.computer-use' },
  search: { kind: 'page', page: 'plugins', tab: 'plugins.search' },
  engines: { kind: 'page', page: 'plugins', tab: 'plugins.subagents' },
  subagents: { kind: 'page', page: 'plugins', tab: 'plugins.subagents' },
  schedules: { kind: 'page', page: 'automation', tab: 'schedules' },
  triggers: { kind: 'page', page: 'automation', tab: 'triggers' },
  history: { kind: 'session-search' },
  archived: { kind: 'archived-sessions' },
}

/** The new home of an old settings link, or undefined when the dialog still owns that page. */
export function settingsMoved(id: string): SettingsMoveTarget | undefined {
  return Object.hasOwn(SETTINGS_MOVED, id) ? SETTINGS_MOVED[id] : undefined
}

export const SETTINGS_EVERYDAY_GROUPS = ['general', 'accounts', 'security', 'application'] as const

export function settingsGroup(group: string): string {
  if (group === 'advanced') return group
  return SETTINGS_EVERYDAY_GROUPS.some((known) => known === group) ? group : 'extensions'
}

/** Listed only while 「显示高级设置」 is on. */
export function advancedSettings(group: string): boolean {
  return settingsGroup(group) === 'advanced'
}

/** Groups whose pages are each listed by name; an everyday group is one entry for all its pages. */
export function listedSettingsGroup(group: string): boolean {
  return settingsGroup(group) !== group || group === 'advanced'
}

/** Pages shown as tabs of one screen: the sections of one everyday group. Listed pages stand alone. */
export function settingsTabGroup(entry: Pick<SettingsNavigationEntry, 'id' | 'group'>): string {
  const group = settingsGroup(entry.group)
  return listedSettingsGroup(entry.group) ? `${group}:${entry.id}` : group
}

/** The entries the dialog lists: every registered section, the advanced ones only while they show. */
export function settingsListedEntries(
  entries: readonly SettingsNavigationEntry[],
  advanced: boolean,
): SettingsNavigationEntry[] {
  return entries.filter((entry) => advanced || !advancedSettings(entry.group))
}

export function settingsNavigationGroups(
  entries: readonly SettingsNavigationEntry[],
): SettingsNavigationEntry[][] {
  const groups = new Map<string, SettingsNavigationEntry[]>()
  for (const entry of [...entries].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const key = settingsGroup(entry.group)
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }
  const order = [...SETTINGS_EVERYDAY_GROUPS, 'extensions', 'advanced']
  return [...groups].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([, group]) => group)
}

/** Title, group and localized synonyms support case/accent/spacing tolerant subsequence search. */
export function matchesSettings(query: string, text: string): boolean {
  const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()
  const sources = normalize(text).split(/\s+/)
  return normalize(query)
    .trim()
    .split(/\s+/)
    .every((word) =>
      sources.some((source) => {
        let cursor = 0
        for (const character of word) {
          const at = source.indexOf(character, cursor)
          if (at < 0) return false
          cursor = at + 1
        }
        return true
      }),
    )
}

export function revealSettingsAnchor(anchor: string): void {
  const node = document.getElementById(anchor)
  if (!node) return
  // A row that opens a subpage is revealed by opening that subpage.
  if (node.dataset.settingsDrill !== undefined) {
    if (node.getAttribute('aria-expanded') !== 'true') node.click()
    return
  }
  // A row that expands in place is revealed by opening its toggle.
  if (node.dataset.settingsExpand !== undefined) {
    const toggle = node.querySelector<HTMLElement>('button[aria-expanded]')
    if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click()
    node.scrollIntoView?.({ block: 'start' })
    toggle?.focus({ preventScroll: true })
    return
  }
  for (let current: HTMLElement | null = node; current; current = current.parentElement)
    if (current instanceof HTMLDetailsElement) current.open = true
    else if (current.classList.contains('agh-disclosure')) setDisclosureOpen(current, true)
  node.scrollIntoView?.({ block: 'start' })
  ;(node.querySelector<HTMLElement>('summary, .agh-disclosure-summary') ?? node).focus({
    preventScroll: true,
  })
}
