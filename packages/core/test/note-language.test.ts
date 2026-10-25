import { presetDefaults } from '@agnes/core-common/step/preset'
import { describe, expect, it } from 'vitest'
import { childReceiptNarrative } from '../src/child/receipts.js'
import { UNATTENDED_NOTE } from '../src/execution/turn/inference.js'
import { progressCheckText } from '../src/execution/turn/progress-check.js'
import { LIMIT_THRESHOLDS, limitNoteText, turnTimeText } from '../src/execution/turn/turn-limits.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { NOTE_LANGUAGE } from '../src/request/note-language.js'
import type { SessionImpl } from '../src/step/session.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

const T0 = 1_757_203_200_000
const ENDING = `\n${NOTE_LANGUAGE}`
const signal = new AbortController().signal

describe('Core notes keep the model in the language of the task', () => {
  it('every note text that asks the model to do or write something ends with the language line', async () => {
    const limits = {
      time: { timeLimitMs: 100_000, deadlineAt: T0 + 100_000 },
      steps: { max: 20, used: 0 },
      credits: { cap: 5, used: 0 },
    }
    const receipts = await childReceiptNarrative({
      key: 'parent',
      d: {
        log: {
          storage: {
            createDelegatedChild() {},
            lookupByKey() {},
            reserve() {},
            listByParent: async () => [{ creationPhase: 'committed', state: 'running' }],
          },
        },
      },
    } as unknown as SessionImpl)
    const texts = [
      ...[0, 1, 2, 3].flatMap((level) =>
        (['time', 'steps', 'credits'] as const).map((kind) => limitNoteText(limits, { level, kind })),
      ),
      turnTimeText(limits.time, T0 + 30_000),
      turnTimeText(limits.time, T0 + 95_000),
      turnTimeText(limits.time, T0 + 120_000),
      progressCheckText(1, 1, 21, '20 model steps so far in this turn.'),
      progressCheckText(2, 1, 41, '5 tool results in a row failed.'),
      UNATTENDED_NOTE,
      receipts,
    ]
    expect(texts).toHaveLength(LIMIT_THRESHOLDS.length * 3 + 3 + 3 + 2 + 2)
    for (const text of texts) {
      expect(text?.endsWith(ENDING), text).toBe(true)
      // Said once, at the end, and the note itself stays English.
      expect(text?.split(NOTE_LANGUAGE)).toHaveLength(2)
    }
  })

  it('so does every Core note a limited, unattended turn with progress checks sends', async () => {
    let now = T0
    const registry = new ToolRegistry()
    registry.add(
      readTool(async () => {
        now += 10_000
        return { content: [{ type: 'text' as const, text: 'ok' }] }
      }),
      { source: 'agnes/tools-core', trust: 'builtin' },
    )
    const provider = fakeProvider([
      ...Array.from({ length: 6 }, () => toolTurn('read', {})),
      textTurn('done'),
    ])
    const preset = { ...presetDefaults(), progressCheck: { everySteps: 3 } }
    const { session } = await openSession({ provider, registry, preset, clock: () => now })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: '请检查文件' }],
      actor: { ...actor, attrs: { interaction: 'unattended' } },
      timeLimitMs: 100_000,
      maxSteps: 30,
    })
    await session.acceptInput()
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')

    const notes = new Map<string, string>()
    for (const request of provider.requests)
      for (const message of request.messages) {
        if (message.role !== 'user') continue
        for (const block of message.content) {
          if (block.type !== 'text') continue
          const live = /^\[live context [a-f0-9]{64}\]\n(core:[^\n]+)\n/.exec(block.text)
          const kind = live?.[1] ?? /^\[(turn time|progress check)\]\n/.exec(block.text)?.[1]
          if (kind) notes.set(block.text, kind)
        }
      }
    expect(new Set(notes.values())).toEqual(
      new Set(['core:turn-limits', 'core:unattended-run', 'turn time', 'progress check']),
    )
    for (const text of notes.keys()) expect(text.endsWith(ENDING), text).toBe(true)
  })
})
