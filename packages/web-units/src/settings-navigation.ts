import { setDisclosureOpen } from '@agnes/web-ui'
import type { SettingsNavigationEntry } from './settings.js'

const merged: Readonly<Record<string, readonly [string, string]>> = {
  bundles: ['models', 'bundles'],
  engines: ['models', 'engines'],
  'system-prompt': ['models', 'system-prompt'],
  memory: ['models', 'memory'],
  context: ['models', 'context'],
  providers: ['diagnostics', 'providers'],
  examples: ['discover', 'examples'],
  // Skill feedback is the third tab of the Skills page, not a page of its own.
  feedback: ['skills', 'feedback'],
  // Credentials are the lower half of the permissions page.
  credentials: ['security', 'credentials'],
}

/** Existing links keep their destination after sections are consolidated. */
export function settingsRoute(id: string): { id: string; anchor?: string; terminal?: boolean } {
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
 * Pages that moved out of settings, by their old `?settings=<id>` value. The dialog no longer lists
 * them; an old link opens the new place instead. An ID that is still registered as a section keeps
 * opening inside the dialog when a page asks for it by name, until its new home replaces it.
 */
export const SETTINGS_MOVED: Readonly<Record<string, SettingsMoveTarget>> = {
  plugins: { kind: 'page', page: 'plugins' },
  discover: { kind: 'page', page: 'plugins', tab: 'market' },
  examples: { kind: 'page', page: 'agents' },
  skills: { kind: 'page', page: 'plugins', tab: 'skills' },
  feedback: { kind: 'page', page: 'plugins', tab: 'review' },
  mcp: { kind: 'page', page: 'plugins', tab: 'mcp' },
  'computer-use': { kind: 'page', page: 'plugins', tab: 'plugins.computer-use' },
  search: { kind: 'page', page: 'plugins', tab: 'plugins.search' },
  schedules: { kind: 'page', page: 'automation', tab: 'schedules' },
  triggers: { kind: 'page', page: 'automation', tab: 'triggers' },
  history: { kind: 'session-search' },
  archived: { kind: 'archived-sessions' },
}

/** The new home of an old settings link, or undefined when the dialog still owns that page. */
export function settingsMoved(id: string): SettingsMoveTarget | undefined {
  return Object.hasOwn(SETTINGS_MOVED, id) ? SETTINGS_MOVED[id] : undefined
}

export const SETTINGS_EVERYDAY_GROUPS = ['general', 'accounts', 'security'] as const

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

/**
 * Pages shown as tabs of one screen. A page that moved but is still registered keeps its siblings
 * as tabs, so everything stays reachable from the place that opened it.
 */
export function settingsTabGroup(entry: Pick<SettingsNavigationEntry, 'id' | 'group'>): string {
  const moved = settingsMoved(entry.id)
  if (moved) return moved.kind === 'page' ? `moved:${moved.page}` : `moved:${moved.kind}`
  const group = settingsGroup(entry.group)
  return listedSettingsGroup(entry.group) ? `${group}:${entry.id}` : group
}

/** The entries the dialog lists: everything registered except pages that moved elsewhere. */
export function settingsListedEntries(
  entries: readonly SettingsNavigationEntry[],
  advanced: boolean,
): SettingsNavigationEntry[] {
  return entries.filter((entry) => !settingsMoved(entry.id) && (advanced || !advancedSettings(entry.group)))
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
  for (let current: HTMLElement | null = node; current; current = current.parentElement)
    if (current instanceof HTMLDetailsElement) current.open = true
    else if (current.classList.contains('agh-disclosure')) setDisclosureOpen(current, true)
  node.scrollIntoView?.({ block: 'start' })
  ;(node.querySelector<HTMLElement>('summary, .agh-disclosure-summary') ?? node).focus({
    preventScroll: true,
  })
}
