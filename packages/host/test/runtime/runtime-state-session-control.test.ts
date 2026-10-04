import { afterEach, expect, it } from 'vitest'
import { createStateSessionControlFixture } from './fixtures/runtime-session-control.js'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
async function fixture() {
  const f = await createStateSessionControlFixture()
  cleanup.push(f.close)
  return f
}
function total(db: Awaited<ReturnType<typeof fixture>>['db']) {
  return db.prepare('SELECT total_changes() n').get()?.n
}
function events(db: Awaited<ReturnType<typeof fixture>>['db']) {
  return db.prepare('SELECT count(*) n FROM events').get()?.n
}
it('accepts pending next-run in one original commit and keeps the applied binding/base effective', async () => {
  const f = await fixture()
  expect((await f.store.readSessionControl({ sessionId: 'session' }, f.context)).ok).toBe(false)
  expect(
    await f.store.sessionControlStatus({ sessionId: 'session', requestId: 'missing' }, f.context),
  ).toEqual({ ok: true, value: null })
  const before = Number(events(f.db))
  const original = f.db
    .prepare(
      "SELECT value_json,body_digest,last_commit_id FROM runtime_records WHERE record_id='run-binding:run'",
    )
    .get()
  const result = await f.store.submitSessionControl(f.command('first', 0, 'base'), f.context)
  expect(result).toMatchObject({
    ok: true,
    value: { status: 'accepted', revision: 1, effective: null, runId: 'run' },
  })
  expect(events(f.db)).toBe(before + 1)
  expect(
    f.db
      .prepare(
        "SELECT value_json,body_digest,last_commit_id FROM runtime_records WHERE record_id='run-binding:run'",
      )
      .get(),
  ).toEqual(original)
  const read = await f.store.readSessionControl({ sessionId: 'session' }, f.context)
  expect(read).toMatchObject({
    ok: true,
    value: {
      revision: 1,
      parameters: { revision: 0, previousRevision: null, presetId: 'leaf', sourceRequestId: 'ticket' },
    },
  })
  if (!read.ok) throw Error('read failed')
  expect(read.value.parameters.presetDigest).toBe(f.configuration.resolve(f.request).presetDigest)
  const writes = total(f.db),
    ledger = events(f.db)
  expect(await f.store.submitSessionControl(f.command('first', 0, 'base'), f.context)).toEqual(result)
  expect(await f.store.sessionControlStatus({ sessionId: 'session', requestId: 'first' }, f.context)).toEqual(
    result,
  )
  expect(total(f.db)).toBe(writes)
  expect(events(f.db)).toBe(ledger)
})
it('serializes one global revision across genuine principals and does not replay another actor result', async () => {
  const f = await fixture(),
    second = await f.secondActor('other-controller')
  const [a, b] = await Promise.all([
    f.store.submitSessionControl(f.command('same', 0), f.context),
    f.store.submitSessionControl(f.command('same', 0), second.context),
  ])
  expect(a).toMatchObject({ ok: true, value: { revision: 1 } })
  expect(b).toMatchObject({ ok: false, error: { code: 'conflict', detailCode: 'session_control_revision' } })
  expect(
    await f.store.sessionControlStatus({ sessionId: 'session', requestId: 'same' }, second.context),
  ).toEqual({ ok: true, value: null })
  const writes = total(f.db)
  expect(await f.store.submitSessionControl(f.command('same', 0, 'base'), f.context)).toMatchObject({
    ok: false,
    error: { detailCode: 'command_payload_mismatch' },
  })
  expect(total(f.db)).toBe(writes)
  expect(await f.store.submitSessionControl(f.command('same', null, 'base'), second.context)).toMatchObject({
    ok: true,
    value: { revision: 2 },
  })
})
it('cold reads original accepted members using new genuine current credential without issuing config again', async () => {
  const f = await fixture(),
    original = await f.store.submitSessionControl(f.command(), f.context)
  const cold = await f.reopen(),
    writes = total(cold.db),
    ledger = events(cold.db)
  expect(cold.context.authorizationRef).not.toBe(f.context.authorizationRef)
  expect(
    await cold.store.sessionControlStatus({ sessionId: 'session', requestId: 'command' }, cold.context),
  ).toEqual(original)
  expect(await cold.store.submitSessionControl(f.command(), cold.context)).toEqual(original)
  expect(await cold.store.readSessionControl({ sessionId: 'session' }, cold.context)).toMatchObject({
    ok: true,
    value: { revision: 1, parameters: { revision: 0 } },
  })
  expect(total(cold.db)).toBe(writes)
  expect(events(cold.db)).toBe(ledger)
})
it.each(['runtime_session_control_commands', 'runtime_session_control_heads'])(
  'refuses missing original %s instead of reporting absent or reseeding',
  async (table) => {
    const f = await fixture()
    expect((await f.store.submitSessionControl(f.command(), f.context)).ok).toBe(true)
    const cold = await f.reopen()
    cold.db.exec(`DELETE FROM ${table}`)
    const writes = total(cold.db)
    expect(
      await cold.store.sessionControlStatus({ sessionId: 'session', requestId: 'missing' }, cold.context),
    ).toMatchObject({ ok: false })
    expect(await cold.store.submitSessionControl(f.command('new', null), cold.context)).toMatchObject({
      ok: false,
    })
    expect(total(cold.db)).toBe(writes)
    expect(cold.db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0)
  },
)
it('rejects a missing historical command permission issuance even when the new credential is current', async () => {
  const f = await fixture()
  expect((await f.store.submitSessionControl(f.command(), f.context)).ok).toBe(true)
  const cold = await f.reopen()
  expect(
    Number(
      cold.db
        .prepare('DELETE FROM runtime_session_control_claims_issued WHERE authorization_ref=?')
        .run(f.context.authorizationRef).changes,
    ),
  ).toBe(1)
  const writes = total(cold.db)
  expect(
    await cold.store.sessionControlStatus({ sessionId: 'session', requestId: 'command' }, cold.context),
  ).toMatchObject({ ok: false })
  expect(total(cold.db)).toBe(writes)
})
it('rolls back the original State commit when the genuine final native identity gate revokes authority', async () => {
  const f = await fixture(),
    before = events(f.db)
  let revoked = 0
  f.setClock(() => {
    if (f.db.prepare('SELECT count(*) n FROM runtime_session_control_commands').get()?.n === 1) {
      revoked += Number(f.identity.revoke(f.actor.authorizationRef))
    }
  })
  expect(await f.store.submitSessionControl(f.command(), f.context)).toMatchObject({ ok: false })
  expect(revoked).toBe(1)
  expect(events(f.db)).toBe(before)
  expect(f.db.prepare('SELECT count(*) n FROM runtime_session_control_commands').get()?.n).toBe(0)
  expect(
    f.db
      .prepare('SELECT revoked FROM runtime_identity_instances WHERE authorization_ref=?')
      .get(f.actor.authorizationRef)?.revoked,
  ).toBe(0)
})
it('returns incompatible for an official unsupported command with no writes', async () => {
  const f = await fixture(),
    writes = total(f.db)
  expect(
    await f.store.submitSessionControl(
      { ...f.command(), command: { kind: 'compact', instructions: null } },
      f.context,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: 'incompatible', detailCode: 'unsupported_session_control_command' },
  })
  expect(total(f.db)).toBe(writes)
})
it('rechecks historical permission after the last sole native Clock and rolls back a real source deletion', async () => {
  const f = await fixture(),
    second = await f.secondActor('other-controller')
  expect((await f.store.submitSessionControl(f.command(), second.context)).ok).toBe(true)
  let armed = false,
    clock = 0,
    deleted = 0
  f.setHook(() => {
    armed = true
  })
  f.setClock(() => {
    if (armed && ++clock === 3)
      deleted += Number(
        f.db
          .prepare('DELETE FROM runtime_session_control_claims_issued WHERE authorization_ref=?')
          .run(second.actor.authorizationRef).changes,
      )
  })
  expect(
    await f.store.sessionControlStatus({ sessionId: 'session', requestId: 'missing' }, f.context),
  ).toMatchObject({ ok: false })
  expect(clock).toBe(3)
  expect(deleted).toBe(1)
  expect(
    f.db
      .prepare('SELECT count(*) n FROM runtime_session_control_claims_issued WHERE authorization_ref=?')
      .get(second.actor.authorizationRef)?.n,
  ).toBe(1)
})
it('cannot turn an accepted command into null by removing its actual Stored member', async () => {
  const f = await fixture()
  expect((await f.store.submitSessionControl(f.command(), f.context)).ok).toBe(true)
  const cold = await f.reopen()
  expect(
    Number(
      cold.db
        .prepare(
          'DELETE FROM runtime_version_bodies WHERE record_id=(SELECT result_record_id FROM runtime_session_control_commands LIMIT 1)',
        )
        .run().changes,
    ),
  ).toBe(1)
  const writes = total(cold.db)
  expect(
    await cold.store.sessionControlStatus({ sessionId: 'session', requestId: 'missing' }, cold.context),
  ).toMatchObject({ ok: false })
  expect(total(cold.db)).toBe(writes)
})
it('refuses cold installation after loss of both control tables while original members remain', async () => {
  const f = await fixture()
  expect((await f.store.submitSessionControl(f.command(), f.context)).ok).toBe(true)
  f.db.exec('DROP TABLE runtime_session_control_heads; DROP TABLE runtime_session_control_commands')
  await expect(f.reopen()).rejects.toThrow(/index schema missing/)
  // A separate readonly connection checks that the failed installation did not rebuild either table.
  const { DatabaseSync } = await import('node:sqlite')
  const read = new DatabaseSync(f.file, { readOnly: true })
  try {
    expect(
      read
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('runtime_session_control_heads','runtime_session_control_commands')",
        )
        .get()?.n,
    ).toBe(0)
    expect(
      read.prepare("SELECT count(*) n FROM runtime_record_versions WHERE record_id LIKE 'scr-%'").get()?.n,
    ).toBe(1)
  } finally {
    read.close()
  }
})
it('denies a genuine same-tenant principal for a different workspace with the same sessionId', async () => {
  const f = await fixture()
  expect((await f.store.submitSessionControl(f.command(), f.context)).ok).toBe(true)
  const foreign = await f.reopen('other-workspace')
  expect(foreign.identity.current(foreign.context)?.identity.principalRef).toBe('controller')
  expect(foreign.context.scope).toMatchObject({ sessionId: 'session', workspaceId: 'other-workspace' })
  const writes = total(foreign.db),
    ledger = events(foreign.db)
  expect(await foreign.store.readSessionControl({ sessionId: 'session' }, foreign.context)).toMatchObject({
    ok: false,
  })
  expect(
    await foreign.store.sessionControlStatus({ sessionId: 'session', requestId: 'command' }, foreign.context),
  ).toMatchObject({ ok: false })
  expect(await foreign.store.submitSessionControl(f.command('foreign', null), foreign.context)).toMatchObject(
    { ok: false },
  )
  expect(total(foreign.db)).toBe(writes)
  expect(events(foreign.db)).toBe(ledger)
})
it('rejects an altered receipt runRevision although this command deliberately did not mutate Run', async () => {
  const f = await fixture()
  expect((await f.store.submitSessionControl(f.command(), f.context)).ok).toBe(true)
  const cold = await f.reopen()
  expect(
    Number(
      cold.db
        .prepare(
          "UPDATE runtime_session_control_commands SET receipt_json=json_set(receipt_json,'$.runRevision',1)",
        )
        .run().changes,
    ),
  ).toBe(1)
  const writes = total(cold.db)
  expect(
    await cold.store.sessionControlStatus({ sessionId: 'session', requestId: 'command' }, cold.context),
  ).toMatchObject({ ok: false })
  expect(total(cold.db)).toBe(writes)
})
