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

const session = (key: string, depth = 0) => ({ session: { key, depth, toolUseId: 'use-1' } }) as never

function named(tools: ReturnType<typeof createScheduleTools>, name: string) {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(name)
  return tool
}

it('refuses a delegated session and a missing catalog', async () => {
  const tools = createScheduleTools(catalog(), () => {})
  const delegated = await named(tools, 'schedule_create').execute({}, session('sess', 1))
  expect(delegated.details).toEqual({ code: 'subagent_session' })
  const missing = named(
    createScheduleTools(undefined, () => {}),
    'schedule_list',
  )
  expect((await missing.execute({}, session('sess'))).details).toEqual({ code: 'internal_error' })
  expect(tools.map((tool) => tool.meta.replay)).toEqual(['never', 'safe', 'never', 'idempotent'])
})

it('creates, lists, and archives only the calling session', async () => {
  const bound: string[] = []
  const tools = createScheduleTools(catalog(), (_id, _session, target) => bound.push(target))
  const byName = (name: string) => named(tools, name)
  const created = await byName('schedule_create').execute(
    { title: 'Standup', prompt: 'Check mail', selector: { daily: { time: '09:00', timeZone: 'UTC' } } },
    session('sess'),
  )
  const id = (created.details as { id: string }).id
  expect(bound).toEqual([id])
  const listed = await byName('schedule_list').execute({}, session('sess'))
  expect(listed.details).toMatchObject({ schedules: [{ id, title: 'Standup' }] })
  expect(bound).toEqual([id, '*'])
  const foreign = await byName('schedule_delete').execute({ id }, session('other'))
  expect(foreign.details).toEqual({ deleted: false })
  const removed = await byName('schedule_delete').execute({ id }, session('sess'))
  expect(removed.details).toEqual({ deleted: true })
  const again = await byName('schedule_delete').execute({ id }, session('sess'))
  expect(again.details).toEqual({ deleted: false })
})

it('rejects after_seconds when updating', async () => {
  const tools = createScheduleTools(catalog(), () => {})
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
