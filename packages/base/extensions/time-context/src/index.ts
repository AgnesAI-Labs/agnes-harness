import { defineExtension, type ProjectionDef } from '@agnes/extension-api'
import { readContextConfig } from '../../context-rules/src/config.js'

type TimeState = { turn: number; sampledAt: number; precedingTurnAt: number | null; endedAt: number | null }
export const timeProjection: ProjectionDef<TimeState> = {
  name: 'clock',
  stateVersion: 1,
  stateSchema: {
    type: 'object',
    required: ['turn', 'sampledAt', 'precedingTurnAt', 'endedAt'],
    properties: {
      turn: { type: 'number' },
      sampledAt: { type: 'number' },
      precedingTurnAt: { type: ['number', 'null'] },
      endedAt: { type: ['number', 'null'] },
    },
    additionalProperties: false,
  },
  init: () => ({ turn: -1, sampledAt: 0, precedingTurnAt: null, endedAt: null }),
  apply(state, event) {
    const time = Date.parse(event.ts)
    if (!Number.isFinite(time)) return state as TimeState
    const data = event.data as { turn?: number; continues?: unknown; reason?: string }
    if (event.type === 'turn/start' && typeof data.turn === 'number')
      return data.continues
        ? { ...state, turn: data.turn }
        : { turn: data.turn, sampledAt: time, precedingTurnAt: state.endedAt, endedAt: state.endedAt }
    if (event.type === 'turn/end' && data.reason !== 'parked') return { ...state, endedAt: time }
    return state as TimeState
  },
}
export function renderTimeContext(now: number, zone: string, preceding: number | null): string {
  const current = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(now)
  const elapsed =
    preceding === null
      ? 'unavailable (first turn)'
      : `${Math.max(0, Math.floor((now - preceding) / 1000))} seconds`
  return `Current time: ${current}\nTime zone: ${zone}. This is the configured display zone; ask for clarification when the user's zone matters.\nElapsed since the preceding turn ended: ${elapsed}.`
}
export default defineExtension((agnes) => {
  const disposers = [
    agnes.registerProjection(timeProjection),
    agnes.registerHook('context', async (_payload, ctx) => {
      const config = readContextConfig()
      if (!config.timeEnabled) return { refreshOnRequest: true }
      const read = await ctx.projections.readOwn<TimeState>('clock')
      if (read.status !== 'available') throw new Error('time context persistence unavailable')
      const now = Date.now()
      const start = read.value.sampledAt || now
      const interval = config.refreshIntervalMs
      const sampledAt =
        interval === 0 ? now : start + Math.floor(Math.max(0, now - start) / interval) * interval
      return {
        refreshOnRequest: true,
        additionalContext: renderTimeContext(sampledAt, config.timeZone, read.value.precedingTurnAt),
      }
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
})
