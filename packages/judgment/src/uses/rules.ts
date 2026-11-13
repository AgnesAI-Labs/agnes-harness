import type { PluginContextFacets } from '@agnes/extension-api'
import { resolveRulesConfig } from '../config.js'
import { deadlineScope, within } from '../deadline.js'
import type { JudgmentRequest } from '../questions.js'
import type { JudgmentRuntime } from '../runtime.js'
import { redactedWindow } from './redacted-window.js'
import {
  createRulesProjection,
  RULES,
  type RulesState,
  ruleIdentity,
  sessionHash,
} from './rules-projection.js'
import question from './rules-questions.json' with { type: 'json' }

export function registerRuleChecks(
  plugin: PluginContextFacets,
  runtime: JudgmentRuntime,
  config: unknown,
): () => void {
  const { signal: ownerSignal, extId } = plugin.self
  const eventLog = plugin.eventLog
  const lifetime = new AbortController()
  const pending = new Set<string>()
  const projection = plugin.projections.register(createRulesProjection(extId))
  const hook = plugin.hooks.register(
    'tool_result',
    async (payload, ctx) => {
      const started = Date.now()
      const scope = deadlineScope(AbortSignal.any([ctx.signal, ownerSignal, lifetime.signal]), 1500)
      const reserved: string[] = []
      try {
        const cfg = resolveRulesConfig(config)
        if (!cfg.enabled || scope.signal.aborted || !ctx.sideCall) return {}
        const read = async () => {
          const result = await within(ctx.projections.readOwn<RulesState>(RULES), scope.signal)
          return result.status === 'available' &&
            !result.value.child &&
            result.value.sessionHash === sessionHash(ctx.session.key)
            ? result.value
            : null
        }
        const state = await read()
        if (!state || state.identities.length >= 2048) return {}
        const rules = cfg.items
          .filter((rule) => rule.tools.includes(payload.name))
          .map((rule) => {
            // Fixed canonical property order and normalized exact tool names define one rule's version.
            const rulesVersion = sessionHash(
              JSON.stringify({ id: rule.id, text: rule.text, tools: rule.tools }),
            )
            return {
              rule,
              rulesVersion,
              identity: ruleIdentity(state.sessionHash!, rulesVersion, payload.name),
            }
          })
          .filter((item) => !state.identities.includes(item.identity) && !pending.has(item.identity))
        if (!rules.length || state.identities.length + rules.length > 2048) return {}
        for (const item of rules) {
          pending.add(item.identity)
          reserved.push(item.identity)
        }
        const judge = await within(runtime.judge({ ...ctx, signal: scope.signal }), scope.signal)
        if (!judge || !runtime.current()?.[0]?.native || scope.signal.aborted) return {}
        const req: JudgmentRequest = {
          state: {
            tool: payload.name,
            args: redactedWindow(JSON.stringify(payload.args), 2000, 'first'),
            result: redactedWindow(
              payload.result.content
                .flatMap((block) => (block.type === 'text' ? [block.text] : []))
                .join('\n'),
              8000,
              'last',
            ),
            rules: Object.fromEntries(
              rules.map((item, i) => [`r${i}`, redactedWindow(item.rule.text, 1000, 'first')]),
            ),
          },
          questions: Object.fromEntries(
            rules.map((_item, i) => [
              `r${i}`,
              {
                ...question,
                instructions: `${question.instructions} Evaluate rule r${i} from state.rules.`,
              } as JudgmentRequest['questions'][string],
            ]),
          ),
        }
        const outcome = await within(
          judge.judge('judgment.rules', req, {
            attemptMs: 1500,
            totalMs: Math.max(0, 1500 - (Date.now() - started)),
            signal: scope.signal,
            idPrefix: `rules:${sessionHash(JSON.stringify([ctx.session.key, payload.toolUseId, rules.map((item) => item.identity)]))}`,
            retry: 'none',
            allowSplit: false,
          }),
          scope.signal,
        )
        if (
          scope.signal.aborted ||
          outcome.status !== 'ok' ||
          outcome.backend !== 'native' ||
          !outcome.probabilityAvailable
        )
          return {}
        const violating = rules.filter((_item, i) => {
          const answer = outcome.answers[`r${i}`]
          return (
            answer?.type === 'noul' && Number.isFinite(answer.noul) && answer.noul >= 0.7 && answer.noul <= 1
          )
        })
        const reminded: string[] = []
        for (const item of violating) {
          const current = await read()
          if (!current || current.identities.length >= 2048 || scope.signal.aborted) return {}
          if (current.identities.includes(item.identity)) continue
          await within(
            eventLog.append('rules.reminded', {
              rulesVersion: item.rulesVersion,
              tool: payload.name,
              identity: item.identity,
            }),
            scope.signal,
          )
          const confirmed = await read()
          if (!confirmed?.identities.includes(item.identity) || scope.signal.aborted) return {}
          reminded.push(redactedWindow(item.rule.text, 1000, 'first'))
        }
        if (!reminded.length || scope.signal.aborted) return {}
        return {
          result: {
            ...payload.result,
            content: [
              ...payload.result.content,
              {
                type: 'text' as const,
                text: `[Untrusted rule reminder / 不可信规则提醒]\n${reminded.join('\n')}\nReview the possible violation; existing permissions, approvals and budgets still apply.`,
              },
            ],
          },
        }
      } catch {
        return {}
      } finally {
        scope.close()
        for (const identity of reserved) pending.delete(identity)
      }
    },
    { timeoutMs: 1500 },
  )
  return () => {
    lifetime.abort()
    pending.clear()
    hook()
    projection()
  }
}
