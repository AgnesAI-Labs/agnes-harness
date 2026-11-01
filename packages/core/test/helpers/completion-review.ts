import { presetDefaults } from '@agnes/core-common/step/preset'
import type { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { Provider } from '@agnes/protocol'
import { expect } from 'vitest'
import { ToolRegistry } from '../../src/registry/tools.js'
import type { Operation, SessionDeps } from '../../src/step/session.js'
import { fakeProvider, textTurn, toolTurn } from './fake-provider.js'
import { actor, openSession, readTool, writeTool } from './open-session.js'

export const signal = () => new AbortController().signal
export const run = (h: Awaited<ReturnType<typeof openSession>>) =>
  h.session.run({ until: 'turn-end', signal: signal() })
const operation: Operation = {
  name: 'review',
  slot: 'before-inference',
  replay: 'safe',
  applicable: async () => 'applied',
  run: async () => ({}),
  completionReviewNote: () => 'Review existing evidence; preserve final artifacts.',
}
export const input = {
  actor,
  content: [{ type: 'text' as const, text: 'Write the result and preserve inputs.' }],
}
export const preset = () => {
  const p = presetDefaults()
  p.completionGate.contractReview = true
  p.model.retry = { maxAttempts: 6, baseDelayMs: 0 }
  return p
}
export const ran = async (h: Awaited<ReturnType<typeof openSession>>) =>
  (await h.log.scan({ type: 'x/core/completion-gate', limit: 100 })).find(
    (row) => (row.data as { status: string }).status === 'ran',
  )!

export async function atReview(
  extra: Omit<Partial<Parameters<typeof openSession>[0]>, 'provider'> & { provider?: Provider } = {},
) {
  const registry = extra.registry ?? new ToolRegistry()
  if (!extra.registry) {
    registry.add(writeTool(), { source: 'test', trust: 'builtin' })
    registry.add(readTool(), { source: 'test', trust: 'builtin' })
  }
  const provider = fakeProvider([toolTurn('write_note', {}), textTurn('candidate'), textTurn('checked')])
  const h = await openSession({ registry, provider, preset: preset(), operations: [operation], ...extra })
  await h.session.enqueue('next-turn', input)
  for (let i = 0; i < 20 && !(await ran(h)); i++) await h.session.step()
  expect(await ran(h)).toBeDefined()
  return { ...h, provider, registry }
}

export async function reopen(
  h: Awaited<ReturnType<typeof atReview>>,
  overrides: Partial<SessionDeps> & { storage?: MemoryStorage } = {},
) {
  await h.session.close()
  return {
    ...h,
    ...(await openSession({
      storage: h.storage,
      registry: h.registry,
      provider: h.session.d.provider,
      preset: h.session.preset,
      operations: [operation],
      ...overrides,
    })),
  }
}
