import type { SettingsNavigationEntry } from './settings.js'

const merged: Readonly<Record<string, readonly [string, string]>> = {
  bundles: ['models', 'bundles'],
  engines: ['models', 'engines'],
  'system-prompt': ['models', 'system-prompt'],
  memory: ['models', 'memory'],
  context: ['models', 'context'],
  providers: ['diagnostics', 'providers'],
  examples: ['discover', 'examples'],
}

/** Existing links keep their destination after sections are consolidated. */
export function settingsRoute(id: string): { id: string; anchor?: string; terminal?: boolean } {
  if (id === 'terminal') return { id: 'jobs', terminal: true }
  const target = merged[id]
  return target ? { id: target[0], anchor: `settings-subsection-${target[1]}` } : { id }
}

export const SETTINGS_EVERYDAY_GROUPS = [
  'accounts',
  'plugins',
  'skills',
  'tools',
  'automation',
  'security',
  'history',
  'general',
] as const

export function settingsGroup(group: string): string {
  if (group === 'mcp' || group === 'computer-use') return 'tools'
  if (group === 'agent' || group === 'diagnostics' || group === 'advanced') return group
  return SETTINGS_EVERYDAY_GROUPS.some((known) => known === group) ? group : 'extensions'
}

export function advancedSettings(group: string): boolean {
  return ['agent', 'diagnostics', 'advanced'].includes(settingsGroup(group))
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
  const order = [...SETTINGS_EVERYDAY_GROUPS, 'extensions', 'agent', 'diagnostics', 'advanced']
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
  node.scrollIntoView?.({ block: 'start' })
  ;(node.querySelector<HTMLElement>('summary') ?? node).focus({ preventScroll: true })
}
