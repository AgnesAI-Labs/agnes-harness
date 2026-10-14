import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import { openScheduleCatalog, type ScheduleCatalog, type ScheduleDb } from '../src/catalog.js'
import { createScheduleTools } from '../src/tools.js'

const NOW = Date.parse('2026-09-07T00:00:00Z')

function catalog(): ScheduleCatalog {
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
  return openScheduleCatalog(sql, () => NOW)
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
