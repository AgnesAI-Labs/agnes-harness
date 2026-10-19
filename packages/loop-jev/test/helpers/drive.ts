import type { LoopContext, LoopFactory } from '@agnes/extension-api'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { createJevLoopFactory } from '../../src/index.js'
import type { JsonObject } from '../../src/types.js'
import { type FakeJev, fakeJev, type JevAct, PICK_RESPOND } from './fake-jev.js'
import { turnView } from './view.js'

export const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
export const textReply = (text: string) =>
  [
    { type: 'text_delta', delta: text },
    { type: 'done', reason: 'stop' },
  ] as never
export const callReply = (name: string, args: object) =>
  [
    { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
    { type: 'done', reason: 'toolUse' },
  ] as never
export const errorReply = (code: string, retryable: boolean) =>
  [{ type: 'error', reason: 'error', code, message: code, retryable }] as never
export function toolPort(results: Record<string, (args: JsonObject) => unknown> = {}) {
  const executed: Array<{ name: string; args: unknown; options: unknown }> = []
  return {
    executed,
    port: {
      execute: async (call: { name: string; args: JsonObject }, _s: unknown, options: unknown) => {
        executed.push({ name: call.name, args: call.args, options })
        return (results[call.name] ?? (() => ok('done')))(call.args)
      },
      batch: async () => [],
    } as never,
  }
}
/** The state Jev was sent in its `i`-th prepared call. */
export function jevState(jev: FakeJev, i: number): JsonObject {
  const payload = jev.prepared[i]?.payload as { state: JsonObject } | undefined
  if (!payload) throw new Error(`Jev was prepared fewer than ${i + 1} times`)
  return payload.state
}
/** The factory with `ports` laid over the context its drivers see. */
export function withPorts(
  factory: LoopFactory,
  ports: (ctx: LoopContext) => Record<string, unknown>,
): LoopFactory {
  const wrap = (ctx: LoopContext): LoopContext =>
    Object.create(
      ctx,
      Object.fromEntries(
        Object.entries(ports(ctx)).map(([key, value]) => [key, { value, enumerable: true }]),
      ),
    ) as LoopContext
  return {
    ...factory,
    create: (ctx, stop) => factory.create(wrap(ctx), stop),
    resume: (ctx, checkpoint, stop) => factory.resume(wrap(ctx), checkpoint, stop),
  }
}
/** Records every checkpoint the driver writes. */
export const recordWrites = (written: JsonObject[]) => (ctx: LoopContext) => ({
  checkpoints: {
    read: () => ctx.checkpoints.read(),
    write: async (checkpoint: Parameters<LoopContext['checkpoints']['write']>[0], association?: never) => {
      written.push(structuredClone(checkpoint.state) as JsonObject)
      await ctx.checkpoints.write(checkpoint, association)
    },
  },
})
export async function run(
  acts: JevAct[],
  o: {
    replies?: unknown[][]
    tools?: ReturnType<typeof toolPort>
    goal?: string
    config?: object
    inputs?: object[]
    sideCall?: boolean
    until?: 'turn-end' | 'idle'
    view?: Parameters<typeof turnView>[0]
    wrap?: (factory: LoopFactory) => LoopFactory
  } = {},
) {
  const jev = fakeJev((n) => acts[n] ?? { pick: PICK_RESPOND })
  const tools = o.tools ?? toolPort()
  const factory = createJevLoopFactory(o.config ?? {})
  const result = await driveLoop(o.wrap ? o.wrap(factory) : factory, {
    inputs: (o.inputs ?? [{ content: [{ type: 'text', text: o.goal ?? 'list the workspace' }] }]) as never,
    turnView: turnView(o.view),
    replies: (o.replies ?? []) as never,
    tools: tools.port,
    maxSteps: 40,
    ...(o.sideCall === false ? {} : { sideCall: jev }),
    ...(o.until ? { until: o.until } : {}),
  })
  const steps = result.events.filter((e) => e.type === 'jev.step').map((e) => e.data as JsonObject)
  const metrics = result.events.filter((e) => e.type === 'jev.metrics').map((e) => e.data as JsonObject)
  return { ...result, jev, tools, steps, metrics }
}
