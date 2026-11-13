import type { SideCallPort, SideCallResult } from '@agnes/extension-api'
import { callAccounting, type JudgmentAccounting } from './accounting.js'
import type { AnswerCache } from './cache.js'
import type { JudgeTarget } from './config.js'
import { deadlineScope, within } from './deadline.js'
import { nativePayload, splitRequest } from './encode.js'
import { type Answers, type JudgmentRequest, parseNativeAnswers, validateRequest } from './questions.js'
import type { JudgmentScheduler } from './scheduler.js'
import { parseAnswers, renderPrompt } from './text-bridge.js'

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
        accounting: { calls },
      })
      if (!deps.chain?.length) return fail('no-judge')
      if (
        !validateRequest(req).ok ||
        !/^[a-z][a-z0-9._-]{0,63}$/.test(purpose) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/.test(opts.idPrefix) ||
        ![opts.attemptMs, opts.totalMs].every((n) => Number.isFinite(n) && n > 0)
      )
        return fail('invalid')
      const whole = deadlineScope(opts.signal, opts.totalMs)
      const end = deps.now() + opts.totalMs
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
      let failure = fail('error')
      try {
        for (let attempt = 0; attempt < targets.length; attempt++) {
          const target = targets[attempt]!
          if (whole.signal.aborted) throw whole.signal.reason
          if (cooldown.active(session, target.route, deps.now())) continue
          const answers: Answers = {}
          const missing = Object.fromEntries(
            Object.entries(req.questions).filter(([id, q]) => {
              const answer = target.native ? deps.cache.get(req.state, target, q) : null
              if (answer) answers[id] = answer
              return !answer
            }),
          )
          if (!Object.keys(missing).length)
            return {
              status: 'ok',
              answers,
              cached: true,
              model: target.model,
              backend: target.native ? 'native' : 'text',
              probabilityAvailable: target.native,
              accounting: { calls },
            }
          let parts: JudgmentRequest[]
          try {
            parts = splitRequest({ state: req.state, questions: missing }, { state: 24000, request: 48000 })
          } catch {
            return fail('invalid')
          }
          if (opts.allowSplit === false && parts.length > 1) return fail('invalid')
          let complete = true
          let retryable = false
          for (let chunk = 0; chunk < parts.length; chunk++) {
            const part = parts[chunk]!
            const remaining = Math.min(opts.attemptMs, end - deps.now())
            if (remaining <= 0) return fail('timeout')
            const scope = deadlineScope(whole.signal, remaining)
            try {
              if (scope.signal.aborted) throw scope.signal.reason
              const prepared = await within(
                deps.port.prepare({
                  label: purpose,
                  target: { route: target.route, model: target.model },
                  deadlineMs: opts.attemptMs,
                  invocationId: `${opts.idPrefix}:c${chunk}:a${attempt}`,
                  ...(target.native
                    ? { payload: nativePayload(part), output: 'json' as const }
                    : { ...renderPrompt(part), output: 'text' as const }),
                }),
                scope.signal,
              )
              const recorded = await within(deps.port.status(prepared.invocationId), scope.signal)
              if (
                recorded.status === 'finished' &&
                (recorded.label !== prepared.label || recorded.requestHash !== prepared.requestHash)
              )
                return fail('invalid')
              if (recorded.status !== 'finished' && recorded.status !== 'absent') return fail('error')
              const replayed = recorded.status === 'finished'
              let result: SideCallResult
              if (replayed) result = recorded.result
              else {
                const entry = callAccounting(prepared)
                const run = () => {
                  if (scope.signal.aborted) throw scope.signal.reason
                  calls.push(entry)
                  return deps.port.invoke(prepared, scope.signal)
                }
                const pending = deps.scheduler ? deps.scheduler.run(scope.signal, run) : run()
                result = await within(pending, scope.signal)
                calls[calls.indexOf(entry)] = callAccounting(prepared, result)
              }
              if (replayed) calls.push(callAccounting(prepared, result, true))
              if (result.status === 'refused') return fail('budget')
              if (result.status === 'failed' && result.reason === 'cancelled') return fail('error')
              if (result.status === 'failed' && result.reason === 'adapter-error' && !result.retryable)
                cooldown.mark(session, target.route, deps.now())
              if (result.status !== 'ok') {
                failure = fail(
                  result.status === 'failed' && result.reason === 'deadline' ? 'timeout' : 'error',
                )
                retryable = result.status === 'failed' && result.retryable
                complete = false
                break
              }
              const parsed = target.native
                ? parseNativeAnswers(result.json, part)
                : parseAnswers(result.text, part)
              if (!parsed) {
                failure = fail('invalid')
                complete = false
                break
              }
              for (const [id, answer] of Object.entries(parsed)) {
                answers[id] = answer
                if (target.native) deps.cache.set(req.state, target, part.questions[id]!, answer)
              }
            } catch (error) {
              if (whole.signal.aborted) throw error
              failure = fail(scope.signal.aborted ? 'timeout' : 'error')
              retryable = scope.signal.aborted
              complete = false
              break
            } finally {
              scope.close()
            }
          }
          if (complete)
            return {
              status: 'ok',
              answers,
              cached: false,
              model: target.model,
              backend: target.native ? 'native' : 'text',
              probabilityAvailable: target.native,
              accounting: { calls },
            }
          if (!retryable) return failure
        }
        return failure
      } catch {
        return fail(!opts.signal.aborted && whole.signal.aborted ? 'timeout' : 'error')
      } finally {
        whole.close()
      }
    },
  }
}
