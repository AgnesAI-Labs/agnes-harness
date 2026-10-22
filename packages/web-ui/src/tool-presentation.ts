import type { UINode } from '@agnes/protocol'
import { baseToolCatalog } from './locales/base-tools.js'
import type { Translate } from './locales/index.js'

/** Optional because plugins own their titles; only the base vocabulary is localized here. */
export function baseToolTitle(name: string, t: Translate): string | undefined {
  const key = `baseTool.${name}`
  return Object.hasOwn(baseToolCatalog.en, key) ? t(key) : undefined
}

/** Localize the title of a recorded summary without translating its user-authored purpose. */
export function localizeToolSummary(summary: string, t: Translate, name?: string): string {
  const reasons = [
    ['This turn contains untrusted tool output; changes require approval', 'approval.reason.taint'],
    ['The tool declares an action requiring approval', 'approval.reason.declared'],
  ] as const
  for (const [text, key] of reasons) summary = summary.replace(text, () => t(key))
  const [leadWithReason = '', ...rest] = summary.split(' · ')
  const lead = leadWithReason.split(' — ')[0] ?? ''
  const known = name && baseToolTitle(name, t)
  if (name && !known) return summary
  const rawName = name ?? summary.split(' ')[0]
  if (rawName && summary.startsWith(`${rawName} `) && baseToolTitle(rawName, t))
    return baseToolTitle(rawName, t) ?? summary
  const legacy = { 'Run command': 'shell', 'Read file': 'read', 'Write file': 'write', 'Edit file': 'edit' }
  const title = known ?? baseToolTitle(legacy[lead as keyof typeof legacy] ?? lead, t)
  if (!title) return summary
  const replace =
    lead === name ||
    lead === 'Run tool' ||
    [baseToolCatalog.en, baseToolCatalog['zh-CN']].some((catalog) =>
      Object.entries(catalog).some(([key, title]) => key.startsWith('baseTool.') && title === lead),
    ) ||
    Object.hasOwn(legacy, lead)
  return replace ? [title + leadWithReason.slice(lead.length), ...rest].join(' · ') : summary
}

export function approvalSummary(node: Extract<UINode, { kind: 'approval' }>, t: Translate): string {
  let name: string | undefined = node.toolName
  try {
    const subject: unknown = JSON.parse(node.subjectText ?? 'null')
    if (!name && subject && typeof subject === 'object' && 'call' in subject) {
      const call = subject.call
      if (call && typeof call === 'object' && 'name' in call && typeof call.name === 'string')
        name = call.name
    }
  } catch {
    /* Old or clipped subjects still have the saved summary. */
  }
  return localizeToolSummary(node.summary, t, name)
}

/** Localize only the base list receipt grammar; role descriptions and unknown output stay literal. */
export function childListOutput(output: string, t: Translate): string {
  const [listing = '', ...roles] = output.split('\nAvailable application roles:\n')
  const text =
    listing === 'no child agents'
      ? t('tool.child.empty')
      : listing
          .split('\n')
          .map((line) => {
            const row =
              /^(\S+) (starting|running|idle|completed|failed|cancelled|interrupted)( continuable)?$/.exec(
                line,
              )
            return row
              ? `${row[1]} ${t(`tool.child.${row[2]}`)}${row[3] ? ` ${t('tool.child.continuable')}` : ''}`
              : line
          })
          .join('\n')
  return roles.length
    ? `${text}\n${t('tool.child.roles')}\n${roles.join('\nAvailable application roles:\n')}`
    : text
}
