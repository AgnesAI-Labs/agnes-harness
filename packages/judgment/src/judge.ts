import type { SideCallPort } from '@agnes/extension-api'
import type { JudgmentAccounting } from './accounting.js'
import type { AnswerCache } from './cache.js'
import type { JudgeTarget } from './config.js'
import { deadlineScope } from './deadline.js'
import { splitRequest } from './encode.js'
import { runInvocation } from './invocation.js'
import { type Answers, type JudgmentRequest, validateRequest } from './questions.js'
import { invocationId, missingQuestions } from './request-plan.js'
import type { JudgmentScheduler } from './scheduler.js'

export interface JudgeOptions {
  attemptMs: number
  totalMs: number
  signal: AbortSignal
  idPrefix: string
  retry?: 'fallback' | 'once' | 'none'
  allowSplit?: boolean
}
export type JudgeOutcome =
  | {
      status: 'ok'
      answers: Answers
      cached: boolean
      model: string
      backend: 'native' | 'text'
      probabilityAvailable: boolean
      accounting: JudgmentAccounting
    }
  | {
      status: 'failed'
      reason: 'no-judge' | 'timeout' | 'budget' | 'error' | 'invalid'
      accounting: JudgmentAccounting
    }
export interface Judge {
  judge(purpose: string, req: JudgmentRequest, opts: JudgeOptions): Promise<JudgeOutcome>
}
export function createRouteCooldown() {
  const until = new Map<string, number>()
  const key = (session: string, route: string) => JSON.stringify([session, route])
  return {
    active(session: string, route: string, now: number) {
      for (const [id, expiry] of until) if (expiry <= now) until.delete(id)
      return (until.get(key(session, route)) ?? 0) > now
    },
    mark(session: string, route: string, now: number) {
      until.set(key(session, route), now + 30000)
    },
    clear() {
      until.clear()
    },
  }
}
export function createJudge(deps: {
  port: SideCallPort
  chain: readonly JudgeTarget[] | null
  cache: AnswerCache
  now: () => number
  cooldown?: ReturnType<typeof createRouteCooldown>
  session?: string
  scheduler?: JudgmentScheduler
}): Judge {
  const cooldown = deps.cooldown ?? createRouteCooldown()
  const session = deps.session ?? ''
  return {
    async judge(purpose, req, opts) {
      const calls: JudgmentAccounting['calls'][number][] = []
      const fail = (reason: Extract<JudgeOutcome, { status: 'failed' }>['reason']): JudgeOutcome => ({
        status: 'failed',
        reason,
        accounting: { calls: [...calls] },
      })
      if (!deps.chain?.length) return fail('no-judge')
      if (
        !validateRequest(req).ok ||
        !/^[a-z][a-z0-9._-]{0,63}$/.test(purpose) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/.test(opts.idPrefix) ||
        ![opts.attemptMs, opts.totalMs].every((n) => Number.isFinite(n) && n > 0)
      )
        return fail('invalid')
      const end = deps.now() + opts.totalMs
      let parts: JudgmentRequest[]
      try {
        parts = splitRequest(req, { state: 24000, request: 48000 })
      } catch {
        return fail('invalid')
      }
      if (opts.allowSplit === false && parts.length > 1) return fail('invalid')
      const remainingTotal = end - deps.now()
      if (remainingTotal <= 0) return fail('timeout')
      const whole = deadlineScope(opts.signal, remainingTotal)
      const primary = deps.chain[0]!
      const fallback = primary.native ? deps.chain.find((t, i) => i > 0 && t.native) : undefined
      const targets =
        opts.retry === 'none'
          ? [primary]
          : opts.retry === 'once'
            ? [primary, fallback ?? primary]
            : fallback
              ? [primary, fallback]
              : [primary]
      let failure: Extract<JudgeOutcome, { status: 'failed' }>['reason'] = 'error'
      const legacy = opts.retry === undefined || opts.retry === 'fallback'
      try {
        for (let attempt = 0; attempt < targets.length; attempt++) {
          const target = targets[attempt]!
          if (whole.signal.aborted) throw whole.signal.reason
          if (cooldown.active(session, target.route, deps.now())) continue
          const answers: Answers = {}
          let complete = true
          let retryable = false
          for (let chunk = 0; chunk < parts.length; chunk++) {
            const full = parts[chunk]!
            const missing = missingQuestions(full, target, deps.cache, answers)
            if (!Object.keys(missing.questions).length) continue
            const units = [{ full, missing, id: invocationId(opts.idPrefix, chunk, attempt) }]
            for (let unit = 0; unit < units.length; unit++) {
              const request = units[unit]!
              const remaining = Math.min(opts.attemptMs, end - deps.now())
              if (remaining <= 0) return fail('timeout')
              const scope = deadlineScope(whole.signal, remaining)
              try {
                if (scope.signal.aborted) throw scope.signal.reason
                const outcome = await runInvocation({
                  port: deps.port,
                  scheduler: deps.scheduler,
                  purpose,
                  target,
                  full: request.full,
                  missing: request.missing,
                  localId: request.id,
                  attemptMs: opts.attemptMs,
                  signal: scope.signal,
                  calls,
                })
                if (whole.signal.aborted) throw whole.signal.reason
                if (outcome.status === 'failed') {
                  if (outcome.cooldown) cooldown.mark(session, target.route, deps.now())
                  if (outcome.stop) return fail(outcome.reason)
                  failure = outcome.reason
                  retryable = legacy || outcome.retryable
                  complete = false
                  break
                }
                for (const [id, answer] of Object.entries(outcome.answers)) {
                  answers[id] = answer
                  if (target.native) deps.cache.set(req.state, target, full.questions[id]!, answer)
                }
                if (unit === 0) {
                  if (
                    opts.allowSplit === false &&
                    Object.keys(full.questions).some((id) => !Object.hasOwn(answers, id))
                  )
                    return fail('invalid')
                  // A receipt may cover the original partial-cache subset only. Recover lost cache-only
                  // questions under stable per-question ids, without changing or resending that receipt.
                  for (const [id, question] of Object.entries(full.questions)) {
                    if (Object.hasOwn(answers, id)) continue
                    const residual = { state: full.state, questions: { [id]: question } }
                    units.push({
                      full: residual,
                      missing: residual,
                      id: invocationId(opts.idPrefix, chunk, attempt, id),
                    })
                  }
                }
              } catch (error) {
                if (whole.signal.aborted) throw error
                failure = scope.signal.aborted ? 'timeout' : 'error'
                // Tool retry requires a terminal retryable receipt. Legacy U2 retains its fallback.
                retryable = legacy
                complete = false
                break
              } finally {
                scope.close()
              }
            }
            if (!complete) break
          }
          if (complete)
            return {
              status: 'ok',
              answers,
              cached: calls.length === 0,
              model: target.model,
              backend: target.native ? 'native' : 'text',
              probabilityAvailable: target.native,
              accounting: { calls: [...calls] },
            }
          if (!retryable) return fail(failure)
        }
        return fail(failure)
      } catch {
        return fail(!opts.signal.aborted && whole.signal.aborted ? 'timeout' : 'error')
      } finally {
        whole.close()
      }
    },
  }
}
