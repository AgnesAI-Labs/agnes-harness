import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { createSchedulesPort, type ScheduleDb } from '@agnes/base/schedule'
import { memoryScheduleJobs } from '@agnes/base/testkit'
import type { ScheduleView } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { callWorkerScheduling, createSchedulingBridge } from '../src/supervisor/scheduling-service.js'

it('exposes the daemon scheduler through all six session-scoped operations', async () => {
  const db = new DatabaseSync(':memory:')
  const sql: ScheduleDb = {
    exec(sql, values) {
      if (values?.length) db.prepare(sql).run(...(values as SQLInputValue[]))
      else db.exec(sql)
    },
    get(sql, values) {
      return db.prepare(sql).get(...((values ?? []) as SQLInputValue[])) as never
    },
    all(sql, values) {
      return db.prepare(sql).all(...((values ?? []) as SQLInputValue[])) as never
    },
    transaction(fn) {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
  const now = 1_800_000_000_000
  let releaseCheck: (() => void) | undefined
  const checking = new Promise<void>((resolve) => {
    releaseCheck = resolve
  })
  const port = createSchedulesPort(
    sql,
    memoryScheduleJobs(),
    () => now,
    async (target) => {
      if (target.loop?.id === 'hold') await checking
      return target.loop?.id === 'missing' ? 'loop_missing' : undefined
    },
  )
  const bridge = createSchedulingBridge(port)
  const signal = new AbortController().signal
  const session = { key: 'session-one', workspaceRoot: '/work' }
  const call = (operation: Parameters<typeof bridge>[1], input: unknown, identity = session) =>
    bridge(identity, operation, input, signal)
  try {
    const workspaces = {
      async restoreBinding(key: string) {
        expect(key).toBe(session.key)
        return { canonicalRoot: session.workspaceRoot } as never
      },
    }
    await expect(callWorkerScheduling(undefined, workspaces, session.key, {}, signal)).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(
      callWorkerScheduling(
        port,
        workspaces,
        session.key,
        { operation: 'list', input: {}, workspaceRoot: '/foreign' },
        signal,
      ),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(
      await callWorkerScheduling(
        port,
        workspaces,
        session.key,
        { operation: 'list', input: {}, workspaceRoot: session.workspaceRoot },
        signal,
      ),
    ).toEqual({ schedules: [] })
    const body = {
      title: 'Report',
      prompt: 'Write it',
      selector: { every_seconds: 3600 },
      target: { kind: 'new-session', cwd: '/work' },
    }
    const row = (await call('upsert', { ...body, owner: 'forged', origin: 'forged' })) as ScheduleView
    expect(row).toMatchObject({ origin: session.key, target: body.target })
    expect(await call('get', { id: row.id })).toEqual(row)
    expect(await call('list', {})).toEqual({ schedules: [row] })
    expect(await call('control', { id: row.id, action: 'pause' })).toMatchObject({ status: 'paused' })
    expect(await call('control', { id: row.id, action: 'resume' })).toMatchObject({ status: 'active' })
    expect(await call('control', { id: row.id, action: 'run' })).toMatchObject({ nextRunAt: now })
    expect(await call('upsert', { id: row.id, ...body, title: 'Updated', target: undefined })).toMatchObject({
      title: 'Updated',
      target: body.target,
    })
    port.recordDispatch(`schedule:${row.id}:2`, { at: now, sessionKey: 'fresh-run' })
    expect(await call('runs', { id: row.id })).toEqual([
      { at: now, outcome: 'delivered', sessionKey: 'fresh-run' },
    ])
    expect(
      await call('list', { recentDeliverySince: now }, { key: 'fresh-run', workspaceRoot: '/work' }),
    ).toMatchObject({ schedules: [], recentDelivery: { title: 'Updated', prompt: 'Write it' } })
    const other = { key: 'other', workspaceRoot: '/work' }
    expect(await call('list', { scope: 'all', sessionKey: session.key }, other)).toEqual({ schedules: [] })
    expect(await call('get', { id: row.id }, other)).toBeUndefined()
    expect(await call('runs', { id: row.id }, other)).toEqual([])
    expect(await call('upsert', { ...body, id: row.id }, other)).toEqual({
      updated: false,
      code: 'schedule_not_found',
    })
    expect(await call('control', { id: row.id, action: 'pause' }, other)).toEqual({
      updated: false,
      code: 'schedule_not_found',
    })
    expect(await call('archive', { id: row.id }, other)).toEqual({ deleted: false })
    for (const target of [
      { kind: 'session', sessionKey: 'other' },
      { kind: 'new-session', cwd: '/other' },
    ])
      await expect(call('upsert', { ...body, target })).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
    await expect(
      call('upsert', { ...body, target: { ...body.target, loop: { id: 'missing', version: '1.0.0' } } }),
    ).rejects.toMatchObject({ data: { code: 'loop_missing' } })
    await expect(call('upsert', { ...body, selector: { after_seconds: -1 } })).rejects.toMatchObject({
      data: { code: 'invalid_rule' },
    })
    await expect(call('control', { id: row.id, action: 'invalid' })).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
    expect(await call('archive', { id: row.id })).toEqual({ deleted: true })
    expect(await call('archive', { id: row.id })).toEqual({ deleted: false })
    expect(await call('list', {})).toEqual({ schedules: [] })
    expect(await call('list', { includeArchived: true })).toMatchObject({
      schedules: [{ id: row.id, status: 'archived' }],
    })
    const controller = new AbortController()
    const pending = bridge(
      session,
      'upsert',
      { ...body, target: { ...body.target, loop: { id: 'hold', version: '1.0.0' } } },
      controller.signal,
    )
    controller.abort(new Error('cancelled during validation'))
    releaseCheck?.()
    await expect(pending).rejects.toThrow('cancelled during validation')
    expect(await call('list', { includeArchived: true })).toMatchObject({ schedules: [{ id: row.id }] })
    expect((await port.list({ scope: 'all', includeArchived: true })).schedules).toHaveLength(1)
    const stopped = AbortSignal.abort(new Error('stopped'))
    await expect(bridge(session, 'upsert', body, stopped)).rejects.toThrow('stopped')
  } finally {
    db.close()
  }
})
