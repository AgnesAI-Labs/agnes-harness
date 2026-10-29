import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { SchedulingService, SlotFill, ToolContext, ToolDef } from '@agnes/extension-api'
import { schedulingKind, schedulingServiceCapabilities } from '@agnes/extension-api'
import type { Context } from '@agnes/plugin-runtime'
import { expect, it } from 'vitest'
import { memoryScheduleJobs } from '../../../testkit/index.js'
import { openScheduleCatalog, type ScheduleDb } from '../src/catalog.js'
import { createScheduleExtension } from '../src/index.js'
import { createScheduleTools } from '../src/tools.js'

const NOW = Date.parse('2026-09-07T00:00:00Z')

function catalog(): (ctx: ToolContext) => Promise<SchedulingService> {
  const db = new DatabaseSync(':memory:')
  const sql: ScheduleDb = {
    exec(statement, params) {
      const bound = (params ?? []) as SQLInputValue[]
      if (bound.length > 0) db.prepare(statement).run(...bound)
      else db.exec(statement)
    },
    get(statement, params) {
      return db.prepare(statement).get(...((params ?? []) as SQLInputValue[])) as never
    },
    all(statement, params) {
      return db.prepare(statement).all(...((params ?? []) as SQLInputValue[])) as never
    },
    transaction(fn) {
      db.exec('BEGIN')
      try {
        const value = fn()
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  const catalog = openScheduleCatalog(sql, memoryScheduleJobs(), () => NOW)
  return async (ctx) => {
    const key = ctx.session.key
    const owned = (id: string) => {
      const row = catalog.read(id)
      return (row?.target.kind === 'session' ? row.target.sessionKey : row?.origin) === key ? row : undefined
    }
    return {
      async list() {
        return { schedules: catalog.list({ sessionKey: key }) }
      },
      async get(id) {
        return owned(id)
      },
      async runs(id) {
        return owned(id)?.runs ?? []
      },
      async upsert(input) {
        return input.id
          ? catalog.update({ ...input, id: input.id, owner: key, origin: key })
          : catalog.create({ ...input, origin: key })
      },
      async control(input) {
        return catalog.control(input.id, input.action)
      },
      async archive(input) {
        return owned(input.id) ? catalog.archive(input.id) : { deleted: false }
      },
    }
  }
}

const session = (key: string, depth = 0) =>
  ({ session: { key, depth, toolUseId: 'use-1', workspaceRoot: '/work/app' } }) as never

function named(tools: ReturnType<typeof createScheduleTools>, name: string) {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(name)
  return tool
}

it('refuses a delegated session and a missing catalog', async () => {
  const tools = createScheduleTools(catalog())
  const delegated = await named(tools, 'schedule_create').execute({}, session('sess', 1))
  expect(delegated.details).toEqual({ code: 'subagent_session' })
  const missing = named(createScheduleTools(undefined), 'schedule_list')
  expect((await missing.execute({}, session('sess'))).details).toEqual({ code: 'internal_error' })
  expect(tools.map((tool) => tool.meta.replay)).toEqual(['never', 'safe', 'never', 'idempotent'])
})

it('creates, lists, and archives only the calling session', async () => {
  const tools = createScheduleTools(catalog())
  const byName = (name: string) => named(tools, name)
  const created = await byName('schedule_create').execute(
    { title: 'Standup', prompt: 'Check mail', selector: { daily: { time: '09:00', timeZone: 'UTC' } } },
    session('sess'),
  )
  const id = (created.details as { id: string }).id
  const listed = await byName('schedule_list').execute({}, session('sess'))
  expect(listed.details).toMatchObject({ schedules: [{ id, title: 'Standup' }] })
  const foreign = await byName('schedule_delete').execute({ id }, session('other'))
  expect(foreign.details).toEqual({ deleted: false })
  const removed = await byName('schedule_delete').execute({ id }, session('sess'))
  expect(removed.details).toEqual({ deleted: true })
  const again = await byName('schedule_delete').execute({ id }, session('sess'))
  expect(again.details).toEqual({ deleted: false })
})

it('rejects after_seconds when updating', async () => {
  const tools = createScheduleTools(catalog())
  const byName = (name: string) => named(tools, name)
  const created = await byName('schedule_create').execute(
    { title: 'Standup', prompt: 'Check mail', selector: { after_seconds: 120 } },
    session('sess'),
  )
  const id = (created.details as { id: string }).id
  const updated = await byName('schedule_update').execute(
    { id, title: 'Standup', prompt: 'Check mail', selector: { after_seconds: 120 } },
    session('sess'),
  )
  expect(updated.details).toEqual({ code: 'invalid_selector' })
})

it('runs recurring work in a new session of this workspace and reminders here, and says where', async () => {
  const tools = createScheduleTools(catalog())
  const byName = (name: string) => named(tools, name)
  const create = named(tools, 'schedule_create')
  // The description steers the model: recurring work → new_session, one-off reminders → current_session.
  expect(create.description).toMatch(/new_session for recurring work/)
  expect(create.description).toMatch(/current_session for one-off reminders/)
  expect(JSON.stringify(create.parameters)).toContain('"required":["title","prompt","selector","target"]')
  const daily = await create.execute(
    {
      title: 'Report',
      prompt: 'Write it',
      selector: { daily: { time: '09:00', timeZone: 'UTC' } },
      target: 'new_session',
    },
    session('sess'),
  )
  expect(daily.details).toMatchObject({
    target: { kind: 'new-session', cwd: '/work/app' },
    origin: 'sess',
    runsIn: 'a new session in /work/app for every run',
  })
  const reminder = await create.execute(
    { title: 'Ping', prompt: 'Continue', selector: { after_seconds: 1800 }, target: 'current_session' },
    session('sess'),
  )
  expect(reminder.details).toMatchObject({
    target: { kind: 'session', sessionKey: 'sess' },
    runsIn: 'this session',
  })
  const listed = await byName('schedule_list').execute({}, session('sess'))
  expect(
    (listed.details as { schedules: { runsIn: string }[] }).schedules.map((row) => row.runsIn).sort(),
  ).toEqual(['a new session in /work/app for every run', 'this session'])
  // Only the session that made a new-session task may change or archive it.
  const id = (daily.details as { id: string }).id
  const foreign = await byName('schedule_update').execute(
    { id, title: 'Mine', prompt: 'Write it', selector: { every_seconds: 3600 } },
    session('other'),
  )
  expect(foreign.details).toEqual({ updated: false, code: 'schedule_not_found' })
  expect((await byName('schedule_delete').execute({ id }, session('other'))).details).toEqual({
    deleted: false,
  })
  const kept = await byName('schedule_update').execute(
    { id, title: 'Weekly report', prompt: 'Write it', selector: { every_seconds: 3600 } },
    session('sess'),
  )
  expect(kept.details).toMatchObject({ title: 'Weekly report', target: { kind: 'new-session' } })
  expect((await byName('schedule_delete').execute({ id }, session('sess'))).details).toEqual({
    deleted: true,
  })
})

it('publishes the official tools, interaction table and delivery notification through the interface', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest.agnes.plugins[0].capabilities.services).toEqual(schedulingServiceCapabilities)
  const row = {
    id: 'sched_0000000000000001',
    title: 'Report',
    prompt: 'Write it',
    selector: { every_seconds: 3600 },
    target: { kind: 'new-session' as const, cwd: '/work/app' },
    origin: 'sess',
    status: 'active' as const,
    nextRunAt: NOW + 3600000,
    revision: 1,
    runs: [],
  }
  const service: SchedulingService = {
    async list(input) {
      return {
        schedules: [row],
        ...(input?.recentDeliverySince ? { recentDelivery: { title: row.title, prompt: row.prompt } } : {}),
      }
    },
    async get() {
      return row
    },
    async upsert() {
      return row
    },
    async control() {
      return row
    },
    async archive() {
      return { deleted: true }
    },
    async runs() {
      return []
    },
  }
  const tools: ToolDef[] = []
  let notification: SlotFill<'notification'> | undefined
  createScheduleExtension().apply({
    tools: {
      register(tool: ToolDef) {
        tools.push(tool)
        return () => {}
      },
    },
    slots: {
      register(_name: string, fill: SlotFill<'notification'>) {
        notification = fill
        return () => {}
      },
    },
    providers: {
      async bindOwn(kind: object) {
        expect(kind).toBe(schedulingKind)
        return service
      },
    },
  } as unknown as Context)
  const surfaces: unknown[] = []
  const ctx = {
    session: { key: 'sess', depth: 0, toolUseId: 'use-1', workspaceRoot: '/work/app' },
    signal: new AbortController().signal,
    tools: {
      async invoke(name: string, input: unknown) {
        expect(name).toBe('ui_render')
        surfaces.push(input)
        return { content: [] }
      },
    },
  } as unknown as ToolContext
  const create = tools.find((tool) => tool.name === 'schedule_create')
  expect(
    (
      await create?.execute(
        { title: 'Report', prompt: 'Write it', selector: { every_seconds: 3600 }, target: 'new_session' },
        ctx,
      )
    )?.details,
  ).toMatchObject({ id: row.id, runsIn: 'a new session in /work/app for every run' })
  expect(surfaces).toMatchObject([
    {
      surface: {
        title: 'Scheduled tasks',
        data: { rows: [{ c0: 'Report', c1: 'New session · /work/app' }] },
      },
    },
  ])
  expect(await notification?.({ trigger: { kind: 'turn_end' }, session: ctx.session } as never)).toEqual({
    title: 'Report',
    body: 'Write it',
  })
})
