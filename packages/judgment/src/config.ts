import type { SideModelEntry } from '@agnes/extension-api'
import { object } from './questions.js'

export type JudgeTarget = { route: string; model: string; native: boolean }
export type StopConfig = { enabled: boolean }
const modelSelection = {
  type: 'object',
  additionalProperties: false,
  properties: {
    route: { type: 'string', minLength: 1, maxLength: 128, description: 'Configured side-model route.' },
    model: { type: 'string', minLength: 1, maxLength: 256, description: 'Model id on the selected route.' },
  },
}
export const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description:
    'Configure a Jev key to make judgment available; unexpected-stop detection requires separate opt-in and is off by default.',
  'x-locales': {
    'zh-CN': { description: '填上 Jev 的 key 即可启用判断模型；意外收工检测默认关闭，需要另外手动开启。' },
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
  const native = (entry: SideModelEntry) => entry.api === 'typesafe-systemone'
  const targets = [
    ...new Map(sideModels.map((entry) => [JSON.stringify([entry.route, entry.model]), entry])).values(),
  ]
  let choices =
    typeof cfg.route === 'string' ? targets.filter((e) => e.route === cfg.route) : targets.filter(native)
  if (typeof cfg.route !== 'string' && new Set(choices.map((e) => e.route)).size !== 1) return null
  if (typeof cfg.model === 'string') choices = choices.filter((e) => e.model === cfg.model)
  if (choices.length !== 1) return null
  const primary = choices[0]!
  const chain: JudgeTarget[] = [{ route: primary.route, model: primary.model, native: native(primary) }]
  const fallback = cfg.fallback
  if (native(primary) && object(fallback)) {
    const hit = targets.find((e) => e.route === fallback.route && e.model === fallback.model && native(e))
    if (hit && (hit.route !== primary.route || hit.model !== primary.model))
      chain.push({ route: hit.route, model: hit.model, native: true })
  }
  return chain
}

export function resolveToolConfig(config: unknown): { find: boolean; batch: boolean } {
  const uses = object(config) && object(config.uses) ? config.uses : {}
  return {
    find: object(uses.find) && uses.find.enabled === true,
    batch: object(uses.batch) && uses.batch.enabled === true,
  }
}
