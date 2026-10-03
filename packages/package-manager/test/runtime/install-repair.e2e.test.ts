import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bindInstallerFixtureOperation,
  coldInstallerStatus,
  inlineInstallerRef,
  installerFixtureRequest,
  installerProcessFixture,
  openInstallerFixture,
} from './fixtures/installer.js'

describe.each(['default', 'reference'])('installer journal process recovery: %s', (providerId) => {
  it.each(['planning', 'applying', 'applied'])(
    'kills an open journal writer at %s and reopens the same durable identity',
    async (phase) => {
      const dir = mkdtempSync(join(tmpdir(), 'installer-kill-'))
      writeFileSync(join(dir, 'request.json'), JSON.stringify(installerFixtureRequest()))
      const child = fork(installerProcessFixture, [], {
        execArgv: ['--import', 'tsx'],
        env: {
          ...process.env,
          INSTALLER_FIXTURE_DIRECTORY: dir,
          INSTALLER_FIXTURE_PROVIDER: providerId,
          INSTALLER_FIXTURE_WRITE: '1',
          INSTALLER_FIXTURE_PHASE: phase,
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      try {
        const [ready] = (await once(child, 'message', { signal: AbortSignal.timeout(30000) })) as [
          { proposalId: string },
        ]
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
        const read = coldInstallerStatus(providerId, dir, ready.proposalId)
        expect(read).toMatchObject({
          ok: true,
          value: {
            status: phase === 'applying' ? 'unknown' : phase,
            revision: phase === 'planning' ? 1 : phase === 'applying' ? 4 : 5,
            requestId: 'fixture-request',
          },
        })
        const reopened = openInstallerFixture(providerId, dir)
        try {
          expect(
            reopened.journal.accept(installerFixtureRequest(), 'fixture-owner').proposal.proposalId,
          ).toBe(ready.proposalId)
          expect(() =>
            reopened.journal.accept({ ...installerFixtureRequest(), reason: 'different' }, 'fixture-owner'),
          ).toThrow('request_input_conflict')
        } finally {
          reopened.close()
        }
      } finally {
        child.kill('SIGKILL')
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('cold-probes the original operation after a lost response and keeps unknown without replay or writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'installer-operation-reopen-'))
    const f = openInstallerFixture(providerId, dir)
    const id = f.journal.accept(installerFixtureRequest(), 'fixture-owner').proposal.proposalId
    const record = bindInstallerFixtureOperation(f.journal, id)
    const original = {
      operationId: record.operation?.operationId,
      planDigest: record.proposal.planDigest,
      state: 'published',
      heads: { kind: 'release', routeId: 'fixture-route', routeRevision: 2, releaseSetId: 'fixture-release' },
      checkpoint: {
        key: 'published',
        inputDigest: record.inputDigest,
        evidence: [inlineInstallerRef({ original: true })],
        completedAt: '2026-10-03T00:00:00Z',
      },
      receipt: { authorityId: 'fixture-maintenance', receiptId: 'original-receipt', digest: '4'.repeat(64) },
    }
    // Separate durable authority evidence, never a second publication owned by the installer.
    writeFileSync(join(dir, 'original-operation.json'), JSON.stringify(original), { flush: true })
    f.close()
    try {
      const journalBefore = readFileSync(join(dir, 'journal.sqlite'))
      const status = coldInstallerStatus(providerId, dir, id)
      expect(status).toMatchObject({
        ok: true,
        value: { status: 'applied', resultRef: { receiptId: 'original-receipt' }, revision: 4 },
      })
      expect(readFileSync(join(dir, 'journal.sqlite'))).toEqual(journalBefore)
      writeFileSync(
        join(dir, 'original-operation.json'),
        JSON.stringify({ ...original, state: 'unknown', receipt: null }),
        { flush: true },
      )
      expect(coldInstallerStatus(providerId, dir, id)).toMatchObject({
        ok: true,
        value: { status: 'unknown', resultRef: null },
      })
      expect(readFileSync(join(dir, 'journal.sqlite'))).toEqual(journalBefore)
      const again = openInstallerFixture(providerId, dir)
      try {
        expect(again.journal.accept(installerFixtureRequest(), 'fixture-owner')).toEqual(record)
        expect(again.journal.read(id).operation?.operationId).toBe('original-upgrade')
        again.journal.compareAndSwap(id, record.proposal.revision, {
          ...record,
          proposal: {
            ...record.proposal,
            revision: record.proposal.revision + 1,
            status: 'applied',
            resultRef: original.receipt,
          },
        })
      } finally {
        again.close()
      }
      // Unknown is not evidence against a previously persisted publication receipt.
      expect(coldInstallerStatus(providerId, dir, id)).toMatchObject({
        ok: true,
        value: { status: 'applied', resultRef: original.receipt },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
