import {
  beforeCompactMetadata,
  compactMetadata,
  contextMetadata,
  createMetadataProjection,
  emptySnapshot,
  requestMetadata,
} from './src/metadata.mjs'
import { readService } from './src/service.mjs'

export const main = {
  inject: ['hooks', 'projections', 'services', 'eventLog', 'self'],
  /** @param {import('@agnes/extension-api').PluginContextFacets} plugin */
  apply(plugin) {
    // Service calls use Host identity, never a session selector from the browser.
    const key = (session) => JSON.stringify([session.key, session.lane])
    const sessions = new Map()
    let active = true
    const put = (id, value) => {
      sessions.delete(id)
      sessions.set(id, value)
      if (sessions.size > 64) sessions.delete(sessions.keys().next().value)
    }
    const record = async (ctx, field, value) => {
      if (!active || ctx.signal.aborted || ctx.replayed) return
      const id = key(ctx.session)
      const previous = sessions.get(id) ?? emptySnapshot()
      const next = {
        ...previous,
        [field]:
          field === 'beforeCompact'
            ? { ...value, previousContextWindow: previous.beforeCompact?.contextWindow ?? null }
            : value,
      }
      // Commit metadata first. Failed persistence never becomes a successful diagnostic read.
      await plugin.eventLog.append('snapshot', next)
      if (active && !ctx.signal.aborted) put(id, next)
    }
    const off = [
      plugin.projections.register(createMetadataProjection(plugin.self.extId)),
      plugin.hooks.register('session_start', (_p, ctx) => {
        sessions.delete(key(ctx.session))
      }),
      plugin.hooks.register('context', async (payload, ctx) => {
        // Diagnostics must never fail a model request or change its content/authority.
        try {
          await record(ctx, 'context', contextMetadata(payload))
        } catch {
          sessions.delete(key(ctx.session))
        }
        return { refreshOnRequest: true }
      }),
      plugin.hooks.register('before_request', async (payload, ctx) => {
        try {
          await record(ctx, 'request', requestMetadata(payload))
        } catch {
          sessions.delete(key(ctx.session))
        }
        return {}
      }),
      plugin.hooks.register('before_compact', async (payload, ctx) => {
        try {
          await record(ctx, 'beforeCompact', beforeCompactMetadata(payload))
        } catch {
          sessions.delete(key(ctx.session))
        }
        return null
      }),
      plugin.hooks.register('compact', async (payload, ctx) => {
        try {
          await record(ctx, 'compact', compactMetadata(payload))
        } catch {
          sessions.delete(key(ctx.session))
        }
      }),
      plugin.hooks.register('shutdown', (_p, ctx) => {
        sessions.delete(key(ctx.session))
      }),
      plugin.services.register({
        ...readService,
        async handler(input, ctx) {
          if (
            !active ||
            ctx.signal.aborted ||
            !ctx.session ||
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).length
          )
            throw new Error('Context diagnostics unavailable')
          const snapshot = sessions.get(key(ctx.session)) ?? null
          return { version: 1, status: snapshot ? 'live' : 'unknown', snapshot: structuredClone(snapshot) }
        },
      }),
    ]
    return () => {
      active = false
      sessions.clear()
      for (const dispose of off.reverse()) dispose()
    }
  },
}
