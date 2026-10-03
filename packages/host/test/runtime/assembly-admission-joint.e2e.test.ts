import { fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Outcome } from '@agnes/extension-api/runtime'
import type { AdmissionProbe } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { admissionFixtureInput } from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'
import { maintenancePayload } from './fixtures/assembly-maintenance.js'

const script = fileURLToPath(new URL('./fixtures/assembly-admission-joint-process.ts', import.meta.url))
type Snapshot = ReturnType<Awaited<ReturnType<typeof openJointAdmission>>['inspect']>
type Reply = { result: Outcome<AdmissionProbe>; snapshot: Snapshot }
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'agnes-joint-admission-'))
  writeFileSync(join(path, 'input.json'), JSON.stringify(admissionFixtureInput()), { mode: 0o600 })
  return path
}
function cold(path: string, operation = 'coordinate'): Reply {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, path, operation], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}
function childAt(path: string, operation: string, checkpoint: string) {
  const child = fork(script, [path, operation, checkpoint], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stderr = '',
    stdout = ''
  child.stderr?.on('data', (data) => {
    stderr += String(data)
  })
  child.stdout?.on('data', (data) => {
    stdout += String(data)
  })
  let timer: ReturnType<typeof setTimeout>
  const ready = Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code]) => {
      throw Error(`child exited ${code}: ${stderr}`)
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`checkpoint timeout: ${stderr}`)), 30_000)
    }),
  ]).finally(() => clearTimeout(timer))
  const done = once(child, 'exit').then(([code, signal]) => ({ code, signal, stdout, stderr }))
  return {
    child,
    ready,
    done,
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      return done
    },
  }
}
function pin(snapshot: Snapshot) {
  const row = snapshot.records.find((record) => record.recordId.startsWith('pin:admission:'))
  return row ? maintenancePayload(row).status : null
}
function unique(snapshot: Snapshot) {
  const decisions = snapshot.created.length + snapshot.cancelled.length
  expect(decisions).toBeLessThanOrEqual(1)
  expect(snapshot.proofs).toHaveLength(decisions)
  expect(snapshot.bindings).toHaveLength(snapshot.created.length)
  const anchored = snapshot.issuer.filter((row) => row.decision_json !== null)
  expect(anchored).toHaveLength(decisions)
  if (snapshot.created.length) {
    expect(pin(snapshot)).toBe('active')
    expect(JSON.parse(String(anchored[0]?.decision_json))).toMatchObject({ kind: 'created' })
  }
  if (snapshot.cancelled.length)
    expect(JSON.parse(String(anchored[0]?.decision_json))).toMatchObject({
      kind: 'cancelled',
      targetId: snapshot.cancelled[0]?.tombstone_id,
    })
}

describe('same SQLite maintenance and real State admission', { timeout: 120_000 }, () => {
  it.each([
    ['coordinate', 'issue:before'],
    ['coordinate', 'issue:after'],
    ['coordinate', 'create:before'],
    ['coordinate', 'create:after'],
    ['cancel', 'cancel:before'],
    ['cancel', 'cancel:after'],
    ['confirm-created', 'confirm:before'],
    ['confirm-created', 'confirm:after'],
    ['confirm-cancelled', 'confirm:before'],
    ['confirm-cancelled', 'confirm:after'],
  ])('keeps the original decision and pin after SIGKILL at %s/%s', async (operation, checkpoint) => {
    const path = directory(),
      process = childAt(path, operation, checkpoint)
    try {
      expect(await process.ready).toMatchObject({ checkpoint })
      expect((await process.kill()).signal).toBe('SIGKILL')
      const killed = cold(path, 'inspect').snapshot
      unique(killed)
      if (checkpoint === 'issue:before') {
        expect(killed.issuer).toHaveLength(0)
        expect(killed.records).toHaveLength(0)
      } else {
        expect(killed.issuer).toHaveLength(1)
        expect(killed.records).toHaveLength(2)
        if (checkpoint.endsWith(':before') || checkpoint === 'create:after' || checkpoint === 'cancel:after')
          expect(pin(killed)).toBe('active')
      }
      if (checkpoint === 'create:before' || checkpoint === 'cancel:before') {
        expect(killed.created).toHaveLength(0)
        expect(killed.cancelled).toHaveLength(0)
        expect(killed.issuer[0]?.decision_json).toBeNull()
      }
      const cancelled = operation === 'cancel' || operation === 'confirm-cancelled'
      const recovered = cold(path, cancelled ? 'cancel' : 'coordinate')
      expect(recovered.result).toMatchObject({
        ok: true,
        value: { state: cancelled ? 'cancelled' : 'created' },
      })
      unique(recovered.snapshot)
      expect(recovered.snapshot.created).toHaveLength(cancelled ? 0 : 1)
      expect(recovered.snapshot.cancelled).toHaveLength(cancelled ? 1 : 0)
      expect(pin(recovered.snapshot)).toBe(cancelled ? 'released' : 'active')
      const replay = cold(path)
      expect(replay.result).toEqual(recovered.result)
      expect(replay.snapshot).toEqual(recovered.snapshot)
    } finally {
      await process.kill()
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('arbitrates create/cancel in two real State processes and cold-replays the winner', async () => {
    const path = directory()
    const fixture = await openJointAdmission(path, admissionFixtureInput())
    expect(await fixture.tickets.issue(fixture.draft(), fixture.context())).toMatchObject({ ok: true })
    await fixture.close()
    const children = ['coordinate', 'cancel'].map((operation) => childAt(path, operation, 'race-start'))
    try {
      await Promise.all(children.map((process) => process.ready))
      for (const process of children) process.child.send('go')
      const outputs = await Promise.all(children.map((process) => process.done))
      for (const output of outputs) expect(output.code, output.stderr).toBe(0)
      const replies = outputs.map((output) => JSON.parse(output.stdout) as Reply)
      expect(replies[0]?.result).toEqual(replies[1]?.result)
      expect(replies[0]?.result).toMatchObject({ ok: true })
      const recovered = cold(path)
      expect(recovered.result).toEqual(replies[0]?.result)
      unique(recovered.snapshot)
      expect(recovered.snapshot.created.length + recovered.snapshot.cancelled.length).toBe(1)
    } finally {
      await Promise.all(children.map((process) => process.kill()))
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('refuses cold create and confirm after all three State decision tables lose a cancelled ticket', async () => {
    const path = directory()
    let fixture = await openJointAdmission(path, admissionFixtureInput())
    try {
      const issued = await fixture.tickets.issue(fixture.draft(), fixture.context())
      if (!issued.ok) throw Error(issued.error.detailCode)
      // Leave the maintenance confirmation pending: refusal must retain this active pin.
      expect(
        await fixture.store.cancelAdmission(
          issued.value.admission.ticketId,
          issued.value.admission.fingerprint,
          fixture.context(),
        ),
      ).toMatchObject({ ok: true, value: { state: 'cancelled' } })
      const original = fixture.inspect().issuer
      fixture.db.exec('BEGIN IMMEDIATE')
      for (const table of [
        'runtime_admissions',
        'runtime_admission_tombstones',
        'runtime_admission_source_proofs',
      ])
        fixture.db.prepare(`DELETE FROM ${table} WHERE ticket_id=?`).run(issued.value.admission.ticketId)
      fixture.db.exec('COMMIT')
      await fixture.close()
      const refused = cold(path, 'create-original')
      expect(refused.result).toMatchObject({
        ok: false,
        error: { code: 'incompatible', detailCode: 'integrity' },
      })
      expect(refused.snapshot.issuer).toEqual(original)
      expect(refused.snapshot.created).toHaveLength(0)
      expect(refused.snapshot.cancelled).toHaveLength(0)
      expect(refused.snapshot.proofs).toHaveLength(0)
      expect(refused.snapshot.bindings).toHaveLength(0)
      expect(pin(refused.snapshot)).toBe('active')
      expect(cold(path).result).toMatchObject({ ok: false, error: { detailCode: 'integrity' } })
      fixture = await openJointAdmission(path, admissionFixtureInput())
      expect(
        await fixture.coordinator.confirm(issued.value.admission.ticketId, fixture.context()),
      ).toMatchObject({ ok: false, error: { detailCode: 'integrity' } })
      expect(fixture.inspect().issuer).toEqual(original)
      expect(pin(fixture.inspect())).toBe('active')
    } finally {
      await fixture.close()
      rmSync(path, { recursive: true, force: true })
    }
  })
})
