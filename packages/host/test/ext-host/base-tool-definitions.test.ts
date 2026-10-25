import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { openScheduleCatalog, type ScheduleWrite } from '@agnes/base/schedule'
import { memoryScheduleJobs } from '@agnes/base/testkit'
import { sanitize } from '@agnes/core'
import { checkToolDef, TOOL_DESCRIPTION_MAX_LENGTH } from '@agnes/extension-api'
import { createSqliteStorage } from '@agnes/host-infrastructure/adapters/storage-sqlite'
import type { InferenceEvent, ToolCall } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

// A built-in tool whose definition fails registration silently takes its whole extension down: in
// October 2026 a ui_render description one code unit over the limit left the runtime without
// ui_render, and every ask_user_question, present and schedule surface failed with
// "unknown tool ui_render".
const baseDir = fileURLToPath(new URL('../../../base', import.meta.url))
const dirs: string[] = []
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-base-defs-')))
  dirs.push(d)
  return d
}
const callTool = (name: string, args: ToolCall['args']): InferenceEvent[] => [
  { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
  { type: 'done', reason: 'toolUse' },
]
const say = (text: string): InferenceEvent[] => [
  { type: 'text_delta', delta: text },
  { type: 'done', reason: 'stop' },
]

describe('built-in base tools', () => {
  it('all load and every registered definition stays within the author check and the wire limit', async () => {
    const dataDir = scratch()
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      provider: new ScriptedProvider({ models: [fakeModel({ route: 'gw', id: 'm1' })], scripts: [] }),
      disableSessionTitle: true,
    })
    try {
      const failed = host
        .extensions()
        .filter((extension) => extension.error)
        .map((extension) => `${extension.id}: ${extension.error?.message}`)
      expect(failed).toEqual([])
      for (const id of ['agnes/intelligent-ui', 'agnes/interaction', 'agnes/deliverables', 'agnes/schedule'])
        expect(
          host.extensions().find((extension) => extension.id === id),
          id,
        ).toMatchObject({ loaded: true })
      const tools = [...host.kernel.tools.snapshot(0).byName.values()]
      const names = tools.map((tool) => tool.name)
      for (const name of ['ui_render', 'ui_update', 'ui_close', 'ui_submit', 'ask_user_question', 'present'])
        expect(names, name).toContain(name)
      // An unattended turn (agh -p, agh run) leaves out exactly the tools that need a person present.
      // ui_submit records a person's answer and present registers files; neither waits on anyone.
      expect(
        tools
          .filter((tool) => tool.meta.requiresUser === true)
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(['ask_user_question', 'ui_close', 'ui_guide', 'ui_render', 'ui_update'])
      for (const tool of tools) {
        expect(checkToolDef(tool), tool.name).toEqual({ ok: true })
        expect(sanitize(tool.description).length, tool.name).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX_LENGTH)
      }
    } finally {
      await host.close()
    }
  })

  it('renders the question, deliverable and schedule surfaces through ui_render', async () => {
    const dataDir = scratch()
    writeFileSync(join(dataDir, 'report.txt'), 'A synthetic report')
    // Its own tables directory: the host below owns `<dataDir>/tables`, and package tables without
    // the host's sessions.db are a refused data directory.
    const schedulerStorage = createSqliteStorage({
      file: join(dataDir, 'scheduler.db'),
      tablesDir: join(dataDir, 'scheduler-tables'),
    })
    cleanup.push(() => schedulerStorage.close())
    const table = schedulerStorage.tables('fixture/scheduler').table('schedules')
    const schedules = openScheduleCatalog(
      {
        exec(sql, params) {
          if (params?.length) table.run(sql, params)
          else table.exec(sql)
        },
        get: (sql, params) => table.get(sql, params),
        all: (sql, params) => table.all(sql, params),
        transaction: (run) => table.transaction(run),
      },
      memoryScheduleJobs(),
    )
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [
        () =>
          callTool('ask_user_question', {
            questions: [{ id: 'days', question: 'How many days?', options: ['2', '3'] }],
          }),
        say('Waiting for your answer.'),
        () => callTool('present', { files: [{ path: 'report.txt', description: 'Review result' }] }),
        say('Here it is.'),
        (request) => {
          expect(request.tools.some((tool) => tool.name === 'schedule_create')).toBe(false)
          expect(request.tools.some((tool) => tool.name === 'tool_describe')).toBe(true)
          return callTool('tool_describe', { name: 'schedule_create' })
        },
        (request) => {
          expect(request.tools.some((tool) => tool.name === 'schedule_create')).toBe(true)
          return callTool('schedule_create', {
            title: 'Weather',
            prompt: 'Check the weather',
            selector: { daily: { time: '08:00', timeZone: 'Asia/Shanghai' } },
            target: 'current_session',
          })
        },
        say('Scheduled.'),
      ],
      onExhausted: 'error',
    })
    const options: Parameters<typeof createTestHost>[0] = {
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      provider,
      disableSessionTitle: true,
      scheduling: async (session, operation, input, signal) => {
        signal.throwIfAborted()
        if (operation === 'list') return { schedules: schedules.list({ sessionKey: session.key }) }
        if (operation === 'get') return schedules.read((input as { id: string }).id)
        if (operation === 'upsert')
          return schedules.create({
            ...(input as ScheduleWrite),
            origin: session.key,
            target: { kind: 'session', sessionKey: session.key },
          })
        throw new Error(`Unexpected scheduling operation: ${operation}`)
      },
      seams: {
        artifacts: {
          put: async (bytes, meta) => {
            const sha256 = createHash('sha256').update(bytes).digest('hex')
            const shard = join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2))
            mkdirSync(shard, { recursive: true })
            writeFileSync(join(shard, sha256), bytes)
            return { sha256, size: bytes.byteLength, mime: meta?.mime ?? 'application/octet-stream' }
          },
        },
      },
    }
    let { host } = await createTestHost(options)
    try {
      const session = await host.createSession({ cwd: dataDir })
      const service = session.intelligentUi
      if (!service) throw new Error('missing Intelligent UI service')
      const prompt = async (text: string) => {
        await session.enqueue('next-turn', {
          content: [{ type: 'text', text }],
          actor: session.d.actor,
          kind: 'prompt',
        })
        return session.run({ until: 'turn-end', signal: new AbortController().signal })
      }
      const surfaces = async () =>
        (await service.read({ sessionId: session.key }, new AbortController().signal)).surfaces
      const failures = () =>
        JSON.stringify(provider.calls.flatMap((call) => call.messages)).match(/unknown tool[^"\\]*/g) ?? []

      expect(await prompt('Ask me')).toMatchObject({ reason: 'completed' })
      expect(failures()).toEqual([])
      const question = (await surfaces()).find((record) => record.surface.data.question !== undefined)
      expect(question?.surface).toMatchObject({ titleKey: 'ui.question.title', placement: { inline: true } })

      expect(await prompt('Show me the file')).toMatchObject({ reason: 'completed' })
      const file = (await surfaces()).find((record) =>
        record.surface.components.every((component) => component.kind === 'artifact-file'),
      )
      expect(file?.artifacts).toEqual({ 'file-0': 'available' })
      const rows = await session.scan({ limit: 500 })
      const registration = rows.find((row) => row.type === 'x/core/artifact.registered')
      const presented = rows.find((row) => row.type === 'tool/result' && row.origin === 'tool:present')
      expect(registration?.trust).toBe('trusted')
      expect(registration!.seq).toBeLessThan(file!.createdSeq)
      expect(file!.createdSeq).toBeLessThan(presented!.seq)

      expect(await prompt('Remind me daily')).toMatchObject({ reason: 'completed' })
      expect(
        (await surfaces()).some((record) => record.surface.title === 'Scheduled tasks'),
        JSON.stringify(await session.scan({ type: 'tool/result', limit: 100 })),
      ).toBe(true)
      expect(failures()).toEqual([])
      const key = session.key
      await host.close()
      ;({ host } = await createTestHost(options))
      const resumed = await host.createSession({ key, cwd: dataDir })
      const restored = await resumed.intelligentUi!.read({ sessionId: key }, new AbortController().signal)
      expect(
        restored.surfaces.find((record) =>
          record.surface.components.every((component) => component.kind === 'artifact-file'),
        )?.artifacts,
      ).toEqual({ 'file-0': 'available' })
    } finally {
      await host.close()
    }
  })
})
