import type { InferenceEvent, ModelRecord, Provider, UISpan, UITurn } from '@agnes/protocol'
import { vi } from 'vitest'
import type { Kernel } from '../../src/kernel.js'
import { MemoryStorage } from '../../src/log/memory-storage.js'
import { attachChildTraces } from '../../src/project/trace.js'
import { projectUI } from '../../src/project/ui.js'
import { presetDefaults } from '../../src/step/preset.js'
import type { SessionImpl } from '../../src/step/session.js'
import type { Event, EventInput, Seq } from '../../src/types.js'
import { sentFor, textTurn } from './fake-provider.js'
import { fakeSeams } from './fake-seams.js'
import { actor, noTimers, testFsOps } from './open-session.js'

export const model = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function until(check: () => Promise<boolean> | boolean, ms = 1_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await wait(2)
  }
  return false
}

/** Child inference streams one delta and then hangs until the child's own abort cuts it. */
export const hangingProvider = (): Provider => ({
  models: () => [model()],
  async *infer(req, o): AsyncIterable<InferenceEvent> {
    yield sentFor(req)
    yield { type: 'text_delta', delta: 'partial child answer' }
    await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve(), { once: true }))
    throw new Error('stream cut')
  },
})

/**
 * Once armed, every commit to the given ledger waits one timer turn first, standing in for a
 * durable write that is slower than the control-record update cancel() makes.
 */
export function slowCommits(storage: MemoryStorage, key: () => string | undefined) {
  const armed = { value: false }
  const commit = storage.commit.bind(storage)
  vi.spyOn(storage, 'commit').mockImplementation(async (target, tx) => {
    if (armed.value && target === key()) await wait(30)
    return commit(target, tx)
  })
  return armed
}

export const scripted = (texts: string[]): Provider => {
  let i = 0
  return {
    models: () => [model()],
    async *infer(req): AsyncIterable<InferenceEvent> {
      const script = textTurn(texts[i++] ?? texts[texts.length - 1] ?? 'done')
      for (const e of script) yield e.type === 'sent' ? sentFor(req) : e
    },
  }
}

const kernels: Kernel[] = []
/** Closes every kernel `setup` opened; call from afterEach. */
export async function closeKernels(): Promise<void> {
  for (const k of kernels.splice(0)) await k.close().catch(() => undefined)
}

type KernelOptions = Parameters<typeof Kernel.create>[0]

/**
 * A kernel on memory storage with one open parent session. The caller builds the kernel from the
 * options (the one production call site stays in host assembly; tests make their own).
 */
export async function setupWith(provider: Provider, create: (options: KernelOptions) => Kernel) {
  const storage = new MemoryStorage()
  const k = create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 1_000, generationLimit: 1, maxFanOut: 8 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
  kernels.push(k)
  const parent = await k.session('parent', { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' })
  return { storage, k, parent }
}

export function spawnChild(parent: SessionImpl, input: string) {
  const create = parent.d.children.createWithKind
  if (!create) throw new Error('kernel child factory must expose createWithKind')
  return create.call(parent.d.children, 'spawn', { parent: parent.key, cwd: '/w', input })
}

export async function cancel(handle: { cancel?: () => Promise<void> }) {
  if (!handle.cancel) throw new Error('kernel child handles must expose cancel')
  await handle.cancel()
}

export const row = (type: string, data: EventInput['data']): EventInput => ({
  type,
  data,
  actor,
  origin: 'system',
  trust: 'trusted',
  lane: 'main',
})

/** One parent turn whose single step spawns each given child; `end: false` leaves it open. */
export function spawnTurn(
  turn: number,
  childKeys: readonly string[],
  opts: { end?: boolean } = {},
): EventInput[] {
  return [
    row('turn/start', { turn, trigger: 'prompt' }),
    row('step/start', { turn, step: 1 }),
    ...childKeys.flatMap((childKey, index) => {
      const toolUseId = `spawn-${turn}-${index}`
      return [
        row('tool/call', { toolUseId, name: 'subagent_spawn', args: { task: childKey }, ordinal: index }),
        row('effect/intent', {
          effectId: `eff-${toolUseId}`,
          kind: 'tool',
          replay: 'never',
          tool: { toolUseId, name: 'subagent_spawn' },
        }),
        row('effect/settled', { effectId: `eff-${toolUseId}`, outcome: 'ok', durationMs: 7 }),
        row('tool/result', {
          toolUseId,
          content: [{ type: 'text', text: `spawned ${childKey}` }],
          structured: { childKey },
          isError: false,
          enforcement: { level: 'full', scope: ['process'] },
          authz: { decisionId: `d-${toolUseId}` },
        }),
      ]
    }),
    row('step/end', { turn, step: 1 }),
    ...(opts.end === false ? [] : [row('turn/end', { reason: 'completed', lastAssistantSeq: null })]),
  ]
}

export const walk = (span: UISpan): UISpan[] => [span, ...span.children.flatMap(walk)]
export const subagentSpan = (turns: readonly UITurn[], childKey: string): UISpan | undefined =>
  turns
    .flatMap((turn) => (turn.trace ? walk(turn.trace) : []))
    .find((span) => span.kind === 'subagent' && span.childSessionKey === childKey)

export async function childRows(storage: MemoryStorage, childKey: string): Promise<Event[]> {
  const record = await storage.lookupByKey(childKey)
  if (!record) throw new Error('missing child record')
  const rows: Event[] = []
  let fromSeq = (record.boundarySeq + 1) as Seq
  for (;;) {
    const page = await storage.scan(childKey, { fromSeq, order: 'asc', limit: 500 })
    rows.push(...page)
    const last = page[page.length - 1]
    if (page.length < 500 || !last) return rows
    fromSeq = (last.seq + 1) as Seq
  }
}

/** Two child runs: the first answers, the second streams one delta and hangs until aborted. */
export const answerThenHang = (): Provider => {
  let i = 0
  return {
    models: () => [model()],
    async *infer(req, o): AsyncIterable<InferenceEvent> {
      if (i++ === 0) {
        for (const e of textTurn('first child answer')) yield e.type === 'sent' ? sentFor(req) : e
        return
      }
      yield sentFor(req)
      yield { type: 'text_delta', delta: 'second child, partial' }
      await new Promise<void>((resolve) =>
        o.signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      throw new Error('stream cut')
    },
  }
}

/** The child fold as the session did it before the cache: every call rescans every child. */
export async function uncachedProjection(
  parent: SessionImpl,
  storage: MemoryStorage,
  surface?: 'tui' | 'web' | 'channel',
) {
  const current = await parent.projectUI(undefined, surface ? { surface } : {})
  const base = await parent.d.ui.view({
    ...(surface ? { surface } : {}),
    ...(current.usage ? { usage: current.usage } : {}),
  })
  const load = async (childKey: string) => {
    try {
      const record = await storage.lookupByKey(childKey)
      if (!record || record.parentKey !== parent.key) return undefined
      const rows = await childRows(storage, childKey)
      if (rows.length === 0) return undefined
      const childTimeline = await projectUI(rows, {
        sessionKey: childKey,
        lane: 'main',
        afterSeq: record.boundarySeq,
      })
      return childTimeline.turns
        .map((turn) => turn.trace)
        .filter((span): span is UISpan => span !== undefined)
    } catch {
      return undefined
    }
  }
  const totals = base.turns[0]?.usage.totals ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  }
  await attachChildTraces(base.turns, load, totals)
  return { current, reference: base }
}
