import { presetDefaults } from '@agnes/core-common/step/preset'
import { describe, expect, it } from 'vitest'
import { childReceiptNarrative } from '../src/child/receipts.js'
import { unattendedNote } from '../src/execution/turn/inference.js'
import { progressCheckText } from '../src/execution/turn/progress-check.js'
import { LIMIT_THRESHOLDS, limitNoteText, turnTimeText } from '../src/execution/turn/turn-limits.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { REQUEST_NOTE_CLOSE, REQUEST_NOTE_OPEN } from '../src/request/derive.js'
import { NOTE_LANGUAGE, noteLanguageLine, promptLanguage } from '../src/request/note-language.js'
import type { SessionImpl } from '../src/step/session.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

const T0 = 1_757_203_200_000
const ENDING = `\n${NOTE_LANGUAGE}`
const signal = new AbortController().signal

describe('the language a prompt is written in, from its script alone', () => {
  it.each([
    ['English', 'Set up an Nginx web server with request logging and save the log to `/var/log/x.log`.'],
    ['English', 'do it'],
    ['Chinese', '请检查文件'],
    // A Chinese request that names English terms, or pastes English code, is still Chinese.
    ['Chinese', '请修复 nginx 配置里的 rate limit 问题'],
    [
      'Chinese',
      '运行测试并修复失败的用例：\n```\nError: expected the value to be defined\n  at test.ts:12\n```',
    ],
    ['Japanese', 'このファイルを確認してください'],
    ['Korean', '이 파일을 확인해 주세요'],
    // Empty, mixed, or a language the script does not tell: the caller keeps the wording naming none.
    [undefined, ''],
    [undefined, '   \n'],
    [undefined, 'Please translate the word 猫 into French for the label'],
    [undefined, 'corrige le bogue dans le fichier de configuration'],
    [undefined, 'Исправь ошибку в файле конфигурации'],
    [undefined, 'go'],
  ])('%s: %j', (language, text) => {
    expect(promptLanguage(text)).toBe(language)
  })

  it('names the language in the closing line, and keeps the old wording when there is none', () => {
    expect(noteLanguageLine('English')).toBe(
      'The user writes in English; keep working and replying in English.',
    )
    expect(noteLanguageLine('Chinese')).toBe(
      'The user writes in Chinese; keep working and replying in Chinese.',
    )
    expect(noteLanguageLine(undefined)).toBe(NOTE_LANGUAGE)
  })
})

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
      unattendedNote(),
      receipts,
    ]
    expect(texts).toHaveLength(LIMIT_THRESHOLDS.length * 3 + 3 + 3 + 2 + 2)
    for (const text of texts) {
      expect(text?.endsWith(ENDING), text).toBe(true)
      // Said once, at the end, and the note itself stays English.
      expect(text?.split(NOTE_LANGUAGE)).toHaveLength(2)
    }
  })

  it.each([
    ['请检查文件', 'Chinese'],
    ['Check the files and fix the failing test', 'English'],
    ['Check 文件 and fix the failing test now', undefined],
  ])(
    'so does every Core note a limited, unattended turn sends, naming the language of %j',
    async (prompt, language) => {
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
        content: [{ type: 'text', text: prompt }],
        actor: { ...actor, attrs: { interaction: 'unattended' } },
        timeLimitMs: 100_000,
        maxSteps: 30,
      })
      await session.acceptInput()
      expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')

      const ending = `\n${noteLanguageLine(language)}`
      const notes = new Map<string, string>()
      for (const request of provider.requests)
        for (const message of request.messages) {
          if (message.role !== 'user') continue
          for (const block of message.content) {
            if (block.type !== 'text') continue
            const live = /^\[live context [a-f0-9]{64}\]\n(core:[^\n]+)\n/.exec(block.text)
            const kind = live?.[1] ?? /^\[(progress check)\]\n/.exec(block.text)?.[1]
            if (kind) notes.set(block.text, kind)
            // The request-only measured time is framed as harness context, with the line inside it.
            if (block.text.startsWith(`${REQUEST_NOTE_OPEN}[turn time]\n`)) {
              expect(block.text.endsWith(REQUEST_NOTE_CLOSE)).toBe(true)
              notes.set(block.text.slice(0, -REQUEST_NOTE_CLOSE.length), 'turn time')
            }
          }
        }
      expect(new Set(notes.values())).toEqual(
        new Set(['core:turn-limits', 'core:unattended-run', 'turn time', 'progress check']),
      )
      for (const text of notes.keys()) expect(text.endsWith(ending), text).toBe(true)
      const unattended = [...notes].find(([, kind]) => kind === 'core:unattended-run')?.[0]
      for (const rule of [
        'choose the least destructive reasonable interpretation',
        'make reversible changes',
        'state assumptions and any further steps in the final reply',
        'Do not take irreversible actions the user did not explicitly request',
        'rewriting or pruning version-control history, gc or reflog expiry, force-pushing, or deleting unnamed data',
      ])
        expect(unattended).toContain(rule)
      // The newest message of every request is the framed note, never a bare instruction.
      for (const request of provider.requests) {
        const last = request.messages.at(-1)?.content[0]
        expect(last?.type === 'text' && last.text.startsWith(REQUEST_NOTE_OPEN)).toBe(true)
      }
    },
  )
})
