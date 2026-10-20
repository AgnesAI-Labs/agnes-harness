import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import type { InferenceEvent } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const ask: InferenceEvent[] = [
  {
    type: 'toolcall_end',
    via: 'native',
    call: {
      toolUseId: '',
      name: 'ask_user_question',
      args: { questions: [{ id: 'days', question: 'How many days?', options: ['2', '3'] }] },
      ordinal: 0,
    },
  },
  { type: 'done', reason: 'toolUse' },
]

it('reads Intelligent UI state without rereading the rest of the session ledger', async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-ui-read-')))
  dirs.push(dataDir)
  const signal = new AbortController().signal
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    disableSessionTitle: true,
    provider: new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [
        () => ask,
        () => [
          { type: 'text_delta', delta: 'Waiting for your answer.' },
          { type: 'done', reason: 'stop' },
        ],
      ],
      onExhausted: 'error',
    }),
  })
  try {
    const session = await host.createSession({ cwd: dataDir })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Ask me' }],
      actor: session.d.actor,
      kind: 'prompt',
    })
    expect(await session.run({ until: 'turn-end', signal })).toMatchObject({ reason: 'completed' })
    const service = session.intelligentUi
    if (!service) throw new Error('missing Intelligent UI service')
    // Every ledger read of this session, whoever asks for it, comes through its log.
    const log = session.d.log
    const scan = log.scan.bind(log)
    let rows = 0
    log.scan = async (query) => {
      const page = await scan(query)
      rows += page.length
      return page
    }
    const read = async () => {
      rows = 0
      const page = await service.read({ sessionId: session.key }, signal)
      return { page, rows }
    }
    const pad = async (count: number) => {
      for (let n = 0; n < count; n++)
        await session.appendExtensionEvent(
          'x/fixture/ui-read/note',
          { n },
          { source: 'fixture/ui-read', trust: 'trusted' },
        )
    }
    const opened = await read()
    expect(opened.page.surfaces).toEqual([
      expect.objectContaining({
        status: 'open',
        surface: expect.objectContaining({ titleKey: 'ui.question.title' }),
      }),
    ])
    await pad(300)
    const short = await read()
    await pad(300)
    const long = await read()
    expect(long.page.lastSeq).toBe(session.lastSeq)
    // The view is unchanged by unrelated rows, and so is the cost of reading it.
    for (const { page } of [short, long])
      expect({ ...page, lastSeq: 0 }).toEqual({ ...opened.page, lastSeq: 0 })
    expect({ short: short.rows, long: long.rows }).toEqual({ short: opened.rows, long: opened.rows })
    expect(opened.rows).toBeLessThan(50)
  } finally {
    await host.close()
  }
})
