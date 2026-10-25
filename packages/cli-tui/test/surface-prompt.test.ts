import type { JsonValue, UiSurface } from '@agnes/protocol'
import { numberedSurfaceInput } from '@agnes/protocol/intelligent-ui'
import { describe, expect, it } from 'vitest'
import { SurfaceInbox, type SurfaceInboxHost } from '../src/surface-inbox.js'
import { pendingSurface } from '../src/surface-prompt.js'

// Consumer fixtures use the protocol contract; producer wiring is covered in Host tests.
function formSurface(id: string, field: string, schema: JsonValue): UiSurface {
  return {
    id,
    revision: 1,
    title: 'Question',
    placement: { inline: true, workbench: true },
    components: [
      {
        id: 'answers',
        kind: 'form',
        dataKey: 'draft',
        actionIds: ['submit'],
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [field],
          properties: { [field]: schema },
        },
      },
    ],
    data: { draft: {} },
    actions: [
      {
        id: 'submit',
        label: 'Submit',
        tool: 'ui_submit',
        argsTemplate: { surfaceId: { literal: id }, answers: { from: 'input', key: 'answers' } },
        paramsSchema: true,
      },
    ],
  }
}

describe('surface prompt', () => {
  it('submits numbered single/multiple choice and free text as ordinary form input', () => {
    const single = formSurface('question', 'pick', { type: 'string', enum: ['A', 'B'] })
    expect(numberedSurfaceInput(single, '2')).toEqual({
      actionId: 'submit',
      input: { answers: { pick: 'B' } },
      selection: {},
    })
    const multi = formSurface('multi', 'pick', {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', enum: ['A', 'B'] },
    })
    expect(numberedSurfaceInput(multi, '1, 2').input).toEqual({ answers: { pick: ['A', 'B'] } })
    const free = formSurface('text', 'explain', { type: 'string', minLength: 1 })
    expect(numberedSurfaceInput(free, 'hello').input).toEqual({ answers: { explain: 'hello' } })
    expect(() => numberedSurfaceInput(single, '3')).toThrow('Choose the listed')
    expect(() => numberedSurfaceInput(multi, '1,1')).toThrow('Choose the listed')
  })
  it('recovers open forms and locks an admitted action after refresh', () => {
    const record = {
      surface: formSurface('q', 'pick', { type: 'string', minLength: 1 }),
      status: 'open' as const,
      owner: 'agnes/intelligent-ui',
      lane: 'main',
      taskId: 'task',
      createdSeq: 1,
      updatedSeq: 1,
    }
    const page = { sessionId: 'session', lastSeq: 1, surfaces: [record], actions: [] }
    expect(pendingSurface(page)).toEqual(record)
    expect(
      pendingSurface({
        ...page,
        actions: [
          {
            sessionId: 'session',
            surfaceId: 'q',
            revision: 1,
            actionId: 'submit',
            commandId: 'one',
            status: 'received',
            seq: 2,
            duplicate: false,
          },
        ],
      }),
    ).toBeUndefined()
    expect(pendingSurface({ ...page, surfaces: [{ ...record, status: 'closed' }] })).toBeUndefined()
  })

  it('builds the next answer from new text after the daemon refuses one, and retries only an unsure send', async () => {
    const record = {
      surface: formSurface('q', 'explain', { type: 'string', minLength: 1 }),
      status: 'open' as const,
      owner: 'agnes/intelligent-ui',
      lane: 'main',
      taskId: 'task',
      createdSeq: 1,
      updatedSeq: 1,
    }
    let seq = 1
    const sent: { commandId: string; input: unknown }[] = []
    const failures: unknown[] = [
      Object.assign(new Error('refused'), { data: { code: 'UI_RATE_LIMIT' } }),
      Object.assign(new Error('lost'), { data: { code: 'OUTCOME_UNKNOWN' } }),
    ]
    const session = {
      id: 'session',
      uiRead: async () => ({ sessionId: 'session', lastSeq: seq, surfaces: [record], actions: [] }),
      uiAction: async (command: { commandId: string; input: unknown }) => {
        sent.push(command)
        const failure = failures.shift()
        if (failure) throw failure
        return { status: 'received', seq: ++seq }
      },
    }
    const host = {
      session: () => session,
      stopped: () => false,
      closed: () => false,
      locale: () => 'en',
      statusBar: { setNotice: () => {} },
      appendLocal: () => {},
      localCommandView: () => ({ render: () => [] }),
      repaint: () => {},
      showError: () => {},
    } as unknown as SurfaceInboxHost
    const inbox = new SurfaceInbox(host)
    await inbox.sync()
    await expect(inbox.answer('first')).rejects.toThrow('refused')
    await expect(inbox.answer('second')).rejects.toThrow('lost')
    await inbox.answer('third')
    expect(sent.map((c) => c.input)).toEqual([
      { answers: { explain: 'first' } },
      { answers: { explain: 'second' } },
      { answers: { explain: 'second' } },
    ])
    expect(sent[2]?.commandId).toBe(sent[1]?.commandId)
    expect(sent[1]?.commandId).not.toBe(sent[0]?.commandId)
  })
})
