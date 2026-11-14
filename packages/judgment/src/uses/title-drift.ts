import { createHash } from 'node:crypto'
import type { Disposer, PluginContextFacets, SessionRef } from '@agnes/extension-api'
import { resolveTitleConfig } from '../config.js'
import { deadlineScope, within } from '../deadline.js'
import type { JudgmentRuntime } from '../runtime.js'
import {
  buildReplanTitleContext,
  buildTitleDriftTurns,
  createTitleProjection,
  TITLE_CONTEXT,
  type TitleState,
} from './title-context.js'
import { isLowSignalTitleInput, maskedTitleText } from './title-preprocess.js'
import questions from './title-questions.json' with { type: 'json' }

type Cadence = { count: number; seq: number; active?: AbortController }
const identity = (session: SessionRef) => JSON.stringify([session.key, session.lane])
export function registerTitleDrift(
  plugin: PluginContextFacets,
  runtime: JudgmentRuntime,
  config: unknown,
): Disposer {
  const cfg = resolveTitleConfig(config)
  const port = plugin.sessionWork
  if (!cfg.enabled || !port) return () => {}
  const ownerSignal = plugin.self.signal
  const lifetime = new AbortController()
  const sessions = new Map<string, Cadence>()
  const projection = plugin.projections.register(createTitleProjection())
  const registration = port.register({
    name: 'title.drift',
    observe(event) {
      const key = identity(event.session)
      if (event.kind !== 'message') {
        sessions.get(key)?.active?.abort()
        sessions.delete(key)
        return
      }
      if (lifetime.signal.aborted || ownerSignal.aborted) return
      const message = event.message
      const state = sessions.get(key) ?? { count: 0, seq: 0 }
      if (event.seq <= state.seq) return
      state.seq = event.seq
      sessions.set(key, state)
      if (
        event.hasGeneratedTitle &&
        message.role === 'user' &&
        message.origin === 'principal' &&
        message.attribution === 'operator' &&
        (message.kind === 'prompt' || message.kind === 'steer') &&
        !isLowSignalTitleInput(maskedTitleText(message.text))
      )
        state.count = Math.min(Number.MAX_SAFE_INTEGER, state.count + 1)
    },
    async run(ctx) {
      const state = sessions.get(identity(ctx.session))
      if (!state || state.count < cfg.refreshAfterPrompts || state.active || !ctx.title) return
      const active = new AbortController()
      state.active = active
      const signal = AbortSignal.any([ctx.signal, ownerSignal, lifetime.signal, active.signal])
      const read = async () => {
        const result = await within(ctx.projections.readOwn<TitleState>(TITLE_CONTEXT), signal)
        return result.status === 'available' && !result.value.child ? result.value : null
      }
      try {
        if (signal.aborted) return
        const inspection = await within(ctx.title.inspect(), signal)
        if (!inspection.eligible || signal.aborted) return
        const current = await read()
        if (!current || !buildTitleDriftTurns(current).length || signal.aborted) return
        // Consume this batch synchronously only after every admission guard passed.
        state.count = 0
        const judgeScope = deadlineScope(signal, 15000)
        let drift = false
        try {
          const judge = await within(runtime.judge({ ...ctx, signal: judgeScope.signal }), judgeScope.signal)
          if (!judge || judgeScope.signal.aborted) return
          const id = createHash('sha256')
            .update(
              JSON.stringify([ctx.session.key, ctx.session.lane, ctx.boundary.endSeq, inspection.revision]),
            )
            .digest('hex')
          const result = await within(
            judge.judge(
              'judgment.title',
              {
                state: { title: inspection.title, recent: buildTitleDriftTurns(current) },
                questions: { fits: { type: 'noul', ...questions.fits } },
              },
              {
                attemptMs: 15000,
                totalMs: 15000,
                signal: judgeScope.signal,
                idPrefix: `title:${id}`,
                allowSplit: false,
              },
            ),
            judgeScope.signal,
          )
          const fits = result.status === 'ok' ? result.answers.fits : undefined
          drift =
            !judgeScope.signal.aborted &&
            fits?.type === 'noul' &&
            Number.isFinite(fits.noul) &&
            fits.noul >= 0 &&
            fits.noul < 0.5
        } finally {
          judgeScope.close()
        }
        if (!drift || signal.aborted) return
        const fresh = await read()
        const latest = await within(ctx.title.inspect(), signal)
        if (!fresh || !latest.eligible || latest.revision !== inspection.revision || signal.aborted) return
        const context = buildReplanTitleContext(fresh)
        if (!context || signal.aborted) return
        // Keep this single flight through Host generation and its conditional acceptance.
        await ctx.title.refresh({ expectedRevision: latest.revision, context })
      } catch {
        // A failed, unknown or cancelled check preserves the accepted title.
      } finally {
        if (state.active === active) delete state.active
      }
    },
  })
  return () => {
    lifetime.abort()
    sessions.clear()
    registration()
    projection()
  }
}
