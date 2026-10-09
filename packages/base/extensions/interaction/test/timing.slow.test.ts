import type { ExtensionAPI, ToolDef } from '@agnes/extension-api'
import { expect, it, vi } from 'vitest'
import { interactionSurfaceId } from '../../../src/interaction-surfaces.js'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import interaction, { questionProjection } from '../src/index.js'

it('continues immediately or at the durable deadline, accepts late answers and cancels an active wait', async () => {
  let state = questionProjection.init()
  let tool: ToolDef | undefined
  const hooks: string[] = []
  interaction({
    registerProjection: () => () => {},
    registerTool: (value: ToolDef) => {
      tool = value
      return () => {}
    },
    registerSlot: () => () => {},
    registerHook: (event: string) => {
      hooks.push(event)
      return () => {}
    },
    events: {
      append: async (_name: string, data: unknown) => {
        state = questionProjection.apply(state, {
          type: 'x/agnes/interaction/requested',
          origin: 'ext:agnes/interaction',
          data,
        } as unknown as Parameters<typeof questionProjection.apply>[1])
        return 1
      },
    },
  } as unknown as ExtensionAPI)
  const base = fakeToolContext()
  const ctx = {
    ...base,
    tools: { ...base.tools, invoke: async () => ({ content: [] }) },
    session: { ...base.session, toolUseId: 'q' },
    projections: {
      readOwn: async () => ({
        status: 'available' as const,
        name: 'questions',
        asOfSeq: 1,
        stateVersion: 2,
        value: state,
      }),
    },
  } as import('@agnes/extension-api').ToolContext
  expect(hooks).toEqual([])
  expect(tool?.meta.isConcurrencySafe).toBe(true)
  if (!tool) throw new Error('question tool did not register')
  const now = Date.now()
  expect(await tool.execute({ questions: [{ id: 'pick', question: 'Pick' }] }, ctx)).toMatchObject({
    details: { status: 'pending', deadline: expect.any(Number) },
  })
  expect(state.questions[0]?.deadline).toBeGreaterThanOrEqual(now)
  const accept = () => {
    const apply = (type: string, data: unknown) => {
      state = questionProjection.apply(state, {
        type,
        data,
        origin: 'ext:agnes/intelligent-ui',
      } as unknown as Parameters<typeof questionProjection.apply>[1])
    }
    apply('x/agnes/intelligent-ui/action.received', {
      record: {
        request: { commandId: 'cmd' },
        invocation: {
          tool: 'ui_submit',
          args: { surfaceId: interactionSurfaceId('q'), answers: { pick: 'Late' } },
        },
      },
    })
    apply('x/agnes/intelligent-ui/action.succeeded', { commandId: 'cmd' })
  }
  accept()
  expect(await tool.execute({ questions: [{ id: 'pick', question: 'Pick' }] }, ctx)).toMatchObject({
    details: { answers: { pick: 'Late' } },
  })
  state = questionProjection.init()
  const waitedAt = Date.now()
  await tool.execute({ questions: [{ id: 'pick', question: 'Pick' }], timeoutMs: 20 }, ctx)
  expect(Date.now() - waitedAt).toBeGreaterThanOrEqual(20)
  const deadline = state.questions[0]?.deadline
  await tool.execute({ questions: [{ id: 'pick', question: 'Pick' }], timeoutMs: 60000 }, ctx)
  expect(state.questions[0]?.deadline).toBe(deadline)
  accept()
  expect(state.questions[0]?.answer).toEqual({ pick: 'Late' })
  state = questionProjection.init()
  const waiting = tool.execute({ questions: [{ id: 'pick', question: 'Pick' }], timeoutMs: 1000 }, ctx)
  await vi.waitFor(() => expect(state.questions.length).toBe(1))
  accept()
  expect(await waiting).toMatchObject({ details: { answers: { pick: 'Late' } } })
  state = questionProjection.init()
  const queued = tool.execute({ questions: [{ id: 'pick', question: 'Pick' }], timeoutMs: 60000 }, ctx)
  await vi.waitFor(() => expect(state.questions.length).toBe(1))
  state = questionProjection.apply(state, {
    type: 'x/agnes/intelligent-ui/action.received',
    origin: 'ext:agnes/intelligent-ui',
    data: {
      record: {
        request: { commandId: 'queued' },
        invocation: {
          tool: 'ui_submit',
          args: { surfaceId: interactionSurfaceId('q'), answers: { pick: 'Queued' } },
        },
      },
    },
  } as unknown as Parameters<typeof questionProjection.apply>[1])
  expect(await queued).toMatchObject({ details: { status: 'pending' } })
  expect(state.questions[0]?.answer).toBeNull() // The safe Loop boundary must execute the collector first.
  state = questionProjection.init()
  const abort = new AbortController()
  const aborted = { ...ctx, signal: abort.signal }
  const pending = tool.execute({ questions: [{ id: 'pick', question: 'Pick' }], timeoutMs: 60000 }, aborted)
  await vi.waitFor(() => expect(state.questions.length).toBe(1))
  abort.abort()
  await expect(pending).rejects.toThrow()
})
