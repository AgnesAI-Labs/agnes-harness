import type { SideCallPort } from '@agnes/extension-api'
import type { AnswerCache } from './cache.js'
import type { JudgeTarget } from './config.js'
import { deadlineScope, within } from './deadline.js'
import { nativePayload, splitRequest } from './encode.js'
import { type Answers, type JudgmentRequest, parseNativeAnswers, validateRequest } from './questions.js'
import { parseAnswers, renderPrompt } from './text-bridge.js'

export type JudgeOutcome =
  | { status: 'ok'; answers: Answers; cached: boolean; model: string }
  | { status: 'failed'; reason: 'no-judge' | 'timeout' | 'budget' | 'error' | 'invalid' }
export interface Judge {
  judge(
    purpose: string,
    req: JudgmentRequest,
    opts: { attemptMs: number; totalMs: number; signal: AbortSignal; idPrefix: string },
  ): Promise<JudgeOutcome>
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
}): Judge {
  const cooldown = deps.cooldown ?? createRouteCooldown()
  const session = deps.session ?? ''
  return {
    async judge(purpose, req, opts) {
      if (!deps.chain?.length) return { status: 'failed', reason: 'no-judge' }
      if (
        !validateRequest(req).ok ||
        !/^[a-z][a-z0-9._-]{0,63}$/.test(purpose) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/.test(opts.idPrefix) ||
        ![opts.attemptMs, opts.totalMs].every((n) => Number.isFinite(n) && n > 0)
      )
        return { status: 'failed', reason: 'invalid' }
      const whole = deadlineScope(opts.signal, opts.totalMs)
      const end = deps.now() + opts.totalMs
      const primary = deps.chain[0]!
      const targets = primary.native ? deps.chain.filter((t) => t.native).slice(0, 2) : [primary]
      let failure: JudgeOutcome = { status: 'failed', reason: 'error' }
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
            return { status: 'ok', answers, cached: true, model: target.model }
          let parts: JudgmentRequest[]
          try {
            parts = splitRequest({ state: req.state, questions: missing }, { state: 24000, request: 48000 })
          } catch {
            return { status: 'failed', reason: 'invalid' }
          }
          let complete = true
          for (let chunk = 0; chunk < parts.length; chunk++) {
            const part = parts[chunk]!
            const remaining = Math.min(opts.attemptMs, end - deps.now())
            if (remaining < 100) return { status: 'failed', reason: 'timeout' }
            const scope = deadlineScope(whole.signal, remaining)
            try {
              if (scope.signal.aborted) throw scope.signal.reason
              const prepared = await within(
                deps.port.prepare({
                  label: purpose,
                  target: { route: target.route, model: target.model },
                  deadlineMs: remaining,
                  invocationId: `${opts.idPrefix}:c${chunk}:a${attempt}`,
                  ...(target.native
                    ? { payload: nativePayload(part), output: 'json' as const }
                    : { ...renderPrompt(part), output: 'text' as const }),
                }),
                scope.signal,
              )
              const result = await within(deps.port.invoke(prepared, scope.signal), scope.signal)
              if (result.status === 'refused') return { status: 'failed', reason: 'budget' }
              if (result.status === 'failed' && result.reason === 'cancelled')
                return { status: 'failed', reason: 'error' }
              if (result.status === 'failed' && result.reason === 'adapter-error' && !result.retryable)
                cooldown.mark(session, target.route, deps.now())
              if (result.status !== 'ok') {
                failure = {
                  status: 'failed',
                  reason: result.status === 'failed' && result.reason === 'deadline' ? 'timeout' : 'error',
                }
                complete = false
                break
              }
              const parsed = target.native
                ? parseNativeAnswers(result.json, part)
                : parseAnswers(result.text, part)
              if (!parsed) {
                failure = { status: 'failed', reason: 'invalid' }
                complete = false
                break
              }
              for (const [id, answer] of Object.entries(parsed)) {
                answers[id] = answer
                if (target.native) deps.cache.set(req.state, target, part.questions[id]!, answer)
              }
            } catch (error) {
              if (whole.signal.aborted) throw error
              failure = { status: 'failed', reason: scope.signal.aborted ? 'timeout' : 'error' }
              complete = false
              break
            } finally {
              scope.close()
            }
          }
          if (complete) return { status: 'ok', answers, cached: false, model: target.model }
        }
        return failure
      } catch {
        return {
          status: 'failed',
          reason: !opts.signal.aborted && whole.signal.aborted ? 'timeout' : 'error',
        }
      } finally {
        whole.close()
      }
    },
  }
}
