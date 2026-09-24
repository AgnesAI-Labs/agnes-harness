import { defineTool } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import type { ToolIndexReader } from '../../../src/mcp/index-table.js'
import type { SkillRuntimeDiscovery } from '../../skills/src/runtime.js'

const READ_ONLY = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe' as const,
  costHint: {},
  deferLoading: false,
  requiresApproval: 'never' as const,
}
const GENERIC_SKILL_TERMS = new Set('a an can find for help i list my please the you'.split(' '))

const capUtf8 = (value: string, bytes: number): string => {
  const encoded = new TextEncoder().encode(value)
  return encoded.byteLength <= bytes
    ? value
    : new TextDecoder().decode(encoded.slice(0, bytes)).replace(/\ufffd$/, '')
}

const normalized = (value: string): string => value.trim().toLocaleLowerCase('en-US')

const asksForSkills = (query: string): boolean => {
  const input = normalized(query)
  return input.includes('skill') || input.includes('技能')
}

function skillQueryIsGeneric(query: string): boolean {
  const words = normalized(query)
    .replaceAll(/skills?/gu, ' ')
    .replaceAll('技能', ' ')
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean)
  if (words.length === 0) return true
  if (words.every((word) => GENERIC_SKILL_TERMS.has(word))) return true
  const remaining = normalized(query)
    .replaceAll(/skills?|技能/giu, '')
    .replaceAll(/[\s\p{P}]/gu, '')
  return /^(请|帮我|你能|可以|找到|查找|列出|我的|有什么|有|吗|呢|了|一个|些|使用)*$/u.test(remaining)
}

const textResult = (text: string, isError = false) => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true as const } : {}),
})

function matchingSkills(runtime: SkillRuntimeDiscovery | undefined, query: string, limit: number) {
  if (!runtime || limit <= 0) return []
  const input = normalized(query)
  if (!input) return []
  const skillSearch = asksForSkills(input)
  const terms = input
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term && term !== 'skill' && term !== 'skills' && term !== '技能')
  const generic = skillSearch && skillQueryIsGeneric(input)
  const ready = runtime
    .list()
    // `ready` is the narrow runtime projection of enabled + trusted + winner. The body remains
    // inside skill_read; this discovery bridge receives only the existing safe descriptor.
    .filter((skill) => skill.actual === 'ready')
  return ready
    .map((skill) => {
      const name = normalized(skill.name)
      const description = normalized(skill.description ?? '')
      const nameMatch = input === name ? 20_000 : input.includes(name) ? 10_000 : 0
      const nameScore = terms.reduce((score, term) => score + (name.includes(term) ? 100 : 0), 0)
      const descriptionScore = terms.reduce((score, term) => score + (description.includes(term) ? 10 : 0), 0)
      return { skill, score: nameMatch + nameScore + descriptionScore }
    })
    .filter(({ score }) => generic || score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.skill.name.localeCompare(b.skill.name) ||
        a.skill.resourceId.localeCompare(b.skill.resourceId),
    )
    .slice(0, limit)
    .map(({ skill }) => skill)
}

export const toolSearchTool = (index: ToolIndexReader, skills?: SkillRuntimeDiscovery) =>
  defineTool({
    name: 'tool_search',
    description:
      'Search deferred tools and ready Skills by name or description, including Skills already in available_skills. Call skill_read with the exact Skill name. Already provided tools can also be queried by exact name. Use tool_describe for parameters.',
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 256 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      },
      { additionalProperties: false },
    ),
    meta: READ_ONLY,
    async execute(args, ctx) {
      const search = () => {
        const limit = args.limit ?? 5
        const skillHits = matchingSkills(skills, args.query, limit)
        const exactSkill = skillHits.some((skill) => normalized(skill.name) === normalized(args.query))
        // A Skill lookup must retain a discovery slot even if matching deferred tools occupy the
        // index. Otherwise an exact Skill can be silently hidden by an unrelated MCP result.
        const reserveSkillSlot = skillHits.length > 0 && (asksForSkills(args.query) || exactSkill)
        const toolLimit = reserveSkillSlot ? limit - 1 : limit
        const eager = ctx.tools.list().find((tool) => normalized(tool.name) === normalized(args.query))
        const hits = index.search(args.query, toolLimit)
        const toolRows =
          eager && !hits.some((hit) => hit.name === eager.name)
            ? [
                `${eager.name} — ${eager.description}\nAlready provided in this session; call it directly or use tool_describe.`,
              ]
            : hits.map(({ name }) => `${name} — ${index.get(name)?.description ?? ''}`)
        const visibleTools = toolRows.slice(0, toolLimit)
        const visibleSkills = skillHits.slice(0, limit - visibleTools.length)
        if (visibleTools.length === 0 && visibleSkills.length === 0)
          return textResult(skills ? 'no matching tools or ready Skills' : 'no matching tools')
        const skillRows = visibleSkills.map(
          (skill) =>
            `Skill ${skill.name} — ${skill.description ?? ''}\n` +
            'Call skill_read with this exact name. Do not search the workspace filesystem.',
        )
        return textResult([...visibleTools, ...skillRows].join('\n'))
      }
      if (!skills) return search()
      if (typeof skills.runInWorkspace !== 'function')
        throw Object.assign(new Error('E_WORKSPACE_REQUIRED: Skill discovery has no workspace invocation'), {
          code: 'E_WORKSPACE_REQUIRED',
        })
      return skills.runInWorkspace(ctx.session.key, async () => search())
    },
  })

export const toolDescribeTool = (index: ToolIndexReader) =>
  defineTool({
    name: 'tool_describe',
    description:
      'Show the description and parameter schema of a deferred or currently provided tool by exact name.',
    parameters: Type.Object(
      { name: Type.String({ minLength: 1, maxLength: 128 }) },
      { additionalProperties: false },
    ),
    meta: READ_ONLY,
    async execute(args, ctx) {
      const visible = ctx.tools.list().find((tool) => tool.name === args.name)
      const row = visible
        ? { name: visible.name, description: visible.description, schema: JSON.stringify(visible.parameters) }
        : index.get(args.name)
      if (!row) return textResult(`unknown tool: ${args.name}`, true)
      return textResult(`${row.name}: ${row.description}\nparameters: ${capUtf8(row.schema, 8192)}`)
    },
  })
