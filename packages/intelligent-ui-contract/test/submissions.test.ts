import { expect, it } from 'vitest'
import { readUiAnswerFact, UI_ANSWER_EVENTS, UI_ANSWER_OWNER, UI_SUBMIT_TOOL } from '../src/submissions.js'

it('adapts historical authenticated answer protocol and refuses other origins or shapes', () => {
  const event = {
    origin: `ext:${UI_ANSWER_OWNER}`,
    type: UI_ANSWER_EVENTS[0],
    data: {
      record: {
        request: { commandId: 'cmd' },
        invocation: {
          tool: UI_SUBMIT_TOOL,
          args: { surfaceId: 'surface', answers: { pick: ['A'], text: 'Answer' } },
        },
      },
    },
  }
  expect(readUiAnswerFact(event)).toEqual({
    kind: 'received',
    commandId: 'cmd',
    surfaceId: 'surface',
    answers: { pick: ['A'], text: 'Answer' },
  })
  expect(readUiAnswerFact({ ...event, origin: 'user' })).toBeUndefined()
  expect(readUiAnswerFact({ ...event, type: 'x/agnes/intelligent-ui/action.failed' })).toBeUndefined()
  expect(
    readUiAnswerFact({
      ...event,
      data: {
        record: {
          ...event.data.record,
          invocation: { tool: 'unrelated', args: event.data.record.invocation.args },
        },
      },
    }),
  ).toBeUndefined()
  expect(
    readUiAnswerFact({
      ...event,
      data: {
        record: {
          ...event.data.record,
          invocation: { tool: UI_SUBMIT_TOOL, args: { surfaceId: 'surface', answers: { pick: [1] } } },
        },
      },
    }),
  ).toBeUndefined()
  expect(readUiAnswerFact({ ...event, type: UI_ANSWER_EVENTS[1], data: { commandId: 'cmd' } })).toEqual({
    kind: 'succeeded',
    commandId: 'cmd',
  })
  const opened = {
    ...event,
    type: UI_ANSWER_EVENTS[2],
    data: { record: { status: 'open', surface: { id: 'surface' } } },
  }
  expect(readUiAnswerFact(opened)).toEqual({ kind: 'presented', surfaceId: 'surface' })
  expect(readUiAnswerFact({ ...opened, origin: 'user' })).toBeUndefined()
  expect(
    readUiAnswerFact({ ...opened, data: { record: { status: 'open', surface: { id: 'x'.repeat(65) } } } }),
  ).toBeUndefined()
})
