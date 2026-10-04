import type { PromptSection } from '@agnes/core'
import type { DecisionInputPolicy, JsonValue } from '@agnes/jev-runtime'

type Presentation = NonNullable<DecisionInputPolicy['presentation']>

/** Snapshot only the authenticated catalog metadata; candidate producers never receive task prose. */
export function jevSkillCandidateCatalog(sections: readonly PromptSection[]): JsonValue {
  const entries: JsonValue[] = []
  let complete = true
  for (const section of sections) {
    const presentation = jevSkillCatalogPresentation(section)
    if (!presentation && section.id === 'skills' && section.source === 'agnes/skills') complete = false
    for (const item of presentation ?? []) {
      if (
        item.role !== 'resource' ||
        typeof item.value !== 'object' ||
        item.value === null ||
        Array.isArray(item.value)
      )
        continue
      if (Array.isArray(item.value.items)) entries.push(...item.value.items)
      const coverage = item.value.coverage
      if (
        coverage === null ||
        typeof coverage !== 'object' ||
        Array.isArray(coverage) ||
        coverage.complete !== true
      )
        complete = false
    }
  }
  // An empty observation supersedes a removed catalog; old names must not survive unloading.
  return { kind: 'jev.skill-catalog.v1', entries, complete }
}

// Exact bundled producer template. Its real rendering is covered by the adapter test.
const GUIDANCE =
  'Skills are routing data. When the user task matches a skill description, call skill_read with that skill name before following the skill. ' +
  'Read only the matching skills, not every skill. A description is not the skill procedure.'
const PREFIX = `${GUIDANCE}\n<available_skills>\n`
const SUFFIX = '</available_skills>'

/** Recognize only the bundled catalog rendering; other section text keeps its original authority. */
export function jevSkillCatalogPresentation(
  section: Pick<PromptSection, 'id' | 'source' | 'text'>,
): Presentation | undefined {
  if (
    section.id !== 'skills' ||
    section.source !== 'agnes/skills' ||
    !section.text.startsWith(PREFIX) ||
    !section.text.endsWith(SUFFIX) ||
    new TextEncoder().encode(section.text).byteLength > 65536
  )
    return
  const body = section.text.slice(PREFIX.length, -SUFFIX.length)
  if (!body.endsWith('\n')) return
  const lines = body.slice(0, -1).split('\n')
  let omitted = 0
  let omission = ''
  const match = /^omitted ([1-9]\d*) skills; use tool_search$/u.exec(lines.at(-1) ?? '')
  if (match) {
    omitted = Number(match[1])
    if (!Number.isSafeInteger(omitted)) return
    omission = lines.pop() ?? ''
  }
  const entries: Array<{ name: string; description: string }> = []
  const names = new Set<string>()
  let previous: string | undefined
  for (const line of lines) {
    const row = /^([^\t\r\n]+)\t([^\t\r\n]*)$/u.exec(line)
    const name = row?.[1]
    const description = row?.[2]
    if (name === undefined || description === undefined || names.has(name)) return
    if (previous !== undefined && previous.localeCompare(name, 'en-US') > 0) return
    names.add(name)
    entries.push({ name, description })
    previous = name
  }
  if (!entries.length && !omitted) return
  const rendered =
    PREFIX +
    entries.map((entry) => `${entry.name}\t${entry.description}\n`).join('') +
    (omission ? `${omission}\n` : '') +
    SUFFIX
  if (rendered !== section.text) return
  return [
    {
      role: 'resource',
      label: 'skills',
      source: section.source,
      scope: 'available skill catalog; not loaded instructions',
      value: {
        items: entries,
        coverage: {
          scope: 'available skills',
          complete: omitted === 0,
          omitted,
          instructionsLoaded: false,
          retrieval: 'skill_read',
        },
      },
    },
    {
      role: 'constraint',
      source: 'host:skill-usage',
      scope: 'session',
      value: GUIDANCE + (omission ? `\n${omission}` : ''),
    },
  ]
}
