import { type SideModelEntry, TOOL_NAME_PATTERN } from '@agnes/extension-api'
import { object } from './questions.js'

export type JudgeTarget = { route: string; model: string; native: boolean }
export type StopConfig = { enabled: boolean }
const modelSelection = {
  type: 'object',
  additionalProperties: false,
  properties: {
    route: { type: 'string', minLength: 1, maxLength: 128, description: 'Configured decision-model route.' },
    model: { type: 'string', minLength: 1, maxLength: 256, description: 'Model id on the selected route.' },
  },
}
export const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description:
    'Configure an Agnes Sys1 or Jev decision-model account to use judgment. Unexpected-stop detection is off by default.',
  'x-locales': {
    'zh-CN': { description: '配置 Agnes Sys1 或 Jev 决策模型账号即可使用判断。意外收工检测默认关闭。' },
  },
  properties: {
    judge: {
      ...modelSelection,
      properties: {
        ...modelSelection.properties,
        fallback: {
          ...modelSelection,
          required: ['route', 'model'],
          description: 'Optional native fallback; never a chat fallback.',
        },
      },
    },
    uses: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...Object.fromEntries(
          ['find', 'batch'].map((name) => [
            name,
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                enabled: {
                  type: 'boolean',
                  default: false,
                  description:
                    'Opt in to redacted model judgment. Human effectiveness evaluation has not been performed.',
                },
              },
            },
          ]),
        ),
        rules: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: {
              type: 'boolean',
              default: false,
              description: 'Opt in to native rule reminders after configured exact tool results.',
            },
            items: {
              type: 'array',
              maxItems: 32,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'text', 'tools'],
                properties: {
                  id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' },
                  text: { type: 'string', minLength: 1, maxLength: 1000 },
                  tools: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 16,
                    uniqueItems: true,
                    items: { type: 'string', pattern: TOOL_NAME_PATTERN.source },
                  },
                },
              },
            },
          },
        },
        title: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: {
              type: 'boolean',
              default: false,
              description: 'Opt in to background automatic-title drift checks.',
              'x-locales': { 'zh-CN': { description: '手动开启后台自动标题漂移检查。' } },
            },
            refreshAfterPrompts: {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
              default: 0,
              description: 'Check after this many meaningful operator prompts; zero disables checks.',
              'x-locales': { 'zh-CN': { description: '累计指定次数的有效操作者提示后检查；0 表示关闭。' } },
            },
          },
        },
        stop: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: {
              type: 'boolean',
              default: false,
              description:
                'Opt in to unexpected-stop detection. Real-session effectiveness has not been evaluated.',
              'x-locales': { 'zh-CN': { description: '手动开启意外收工检测。真实会话效果尚未评测。' } },
            },
          },
        },
      },
    },
  },
}
export function resolveStopConfig(config: unknown): StopConfig {
  const uses = object(config) && object(config.uses) ? config.uses : {}
  return { enabled: object(uses.stop) && uses.stop.enabled === true }
}
export function resolveJudgeChain(
  config: unknown,
  sideModels: readonly SideModelEntry[],
): readonly JudgeTarget[] | null {
  const cfg = object(config) && object(config.judge) ? config.judge : {}
  const targets = [
    ...new Map(sideModels.map((entry) => [JSON.stringify([entry.route, entry.model]), entry])).values(),
  ]
  const choices = judgmentCandidates(cfg, targets)
  if (choices.length !== 1) return null
  const primary = choices[0]!
  const chain: JudgeTarget[] = [
    { route: primary.route, model: primary.model, native: isNativeJudge(primary) },
  ]
  const fallback = cfg.fallback
  if (isNativeJudge(primary) && object(fallback)) {
    const hit = targets.find(
      (e) => e.route === fallback.route && e.model === fallback.model && isNativeJudge(e),
    )
    if (hit && (hit.route !== primary.route || hit.model !== primary.model))
      chain.push({ route: hit.route, model: hit.model, native: true })
  }
  return chain
}

const isNativeJudge = (entry: SideModelEntry) =>
  entry.api === 'agnes-sys1' || entry.api === 'typesafe-systemone'

export function judgmentCandidates(
  cfg: Readonly<Record<string, unknown>>,
  targets: readonly SideModelEntry[],
): SideModelEntry[] {
  const choices = targets.filter(
    (entry) =>
      entry.api !== 'openai-audio' &&
      (typeof cfg.route === 'string' ? entry.route === cfg.route : isNativeJudge(entry)) &&
      (typeof cfg.model !== 'string' || entry.model === cfg.model),
  )
  if (typeof cfg.route === 'string' || typeof cfg.model === 'string') return choices
  const sys1 = choices.filter((entry) => entry.api === 'agnes-sys1')
  return sys1.length ? sys1 : choices
}

export function resolveToolConfig(config: unknown): { find: boolean; batch: boolean } {
  const uses = object(config) && object(config.uses) ? config.uses : {}
  return {
    find: object(uses.find) && uses.find.enabled === true,
    batch: object(uses.batch) && uses.batch.enabled === true,
  }
}

export type Rule = { id: string; text: string; tools: string[] }
export function resolveRulesConfig(config: unknown): { enabled: boolean; items: Rule[] } {
  const uses = object(config) && object(config.uses) ? config.uses : {}
  const rules = object(uses.rules) ? uses.rules : {}
  if (rules.enabled !== true || !Array.isArray(rules.items) || rules.items.length > 32)
    return { enabled: false, items: [] }
  const items: Rule[] = []
  for (const item of rules.items) {
    if (
      !object(item) ||
      typeof item.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(item.id) ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      item.text.length > 1000 ||
      !Array.isArray(item.tools) ||
      !item.tools.length ||
      item.tools.length > 16 ||
      item.tools.some((tool) => typeof tool !== 'string' || !TOOL_NAME_PATTERN.test(tool)) ||
      items.some((rule) => rule.id === item.id)
    )
      return { enabled: false, items: [] }
    items.push({ id: item.id, text: item.text, tools: [...new Set(item.tools as string[])].sort() })
  }
  return { enabled: true, items }
}

export function resolveTitleConfig(config: unknown): { enabled: boolean; refreshAfterPrompts: number } {
  const uses = object(config) && object(config.uses) ? config.uses : {}
  const title = object(uses.title) ? uses.title : {}
  const n = title.refreshAfterPrompts
  const refreshAfterPrompts = typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0
  return { enabled: title.enabled === true && refreshAfterPrompts > 0, refreshAfterPrompts }
}
