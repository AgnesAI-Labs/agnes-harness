import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallContext } from '@agnes/extension-api/runtime'
import type { AuthorityRoute, MigrationRequest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { inlineData } from '../../../src/runtime/maintenance/authority-publication.js'
import { openBootstrapAnchor, readStageZero } from '../../../src/runtime/maintenance/bootstrap-locator.js'
import { createDirectoryTransferAdapter } from '../../../src/runtime/migration/directory-transfer.js'
import {
  createAuthorityDirectoryProvider,
  createDirectoryAnchor,
} from '../../../src/runtime/providers/authority-directory.js'

const authority = { authorityId: 'directory-authority', tenantId: 'synthetic-tenant', authorityEpoch: 1 }
const context = (): CallContext => ({
  principalRef: 'maintainer',
  scope: { kind: 'installation', installationId: 'install' },
  bindingId: 'maintenance',
  invocationId: 'invoke',
  deadline: '2099-01-01T00:00:00.000Z',
  traceRef: 'trace',
  authorizationRef: 'authorization',
  signal: new AbortController().signal,
})
const repository = fileURLToPath(new URL('../../../../..', import.meta.url))
// Test-only process entry; the production adapter has no executable entry point.
const childCode = `
import { readFileSync } from 'node:fs';
import { createDirectoryTransferAdapter } from './packages/host/src/runtime/migration/directory-transfer.ts';
import { createAuthorityDirectoryProvider } from './packages/host/src/runtime/providers/authority-directory.ts';
import { readStageZero } from './packages/host/src/runtime/maintenance/bootstrap-locator.ts';
const payload = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const ctx = { ...payload.context, signal: new AbortController().signal };
const adapter = createDirectoryTransferAdapter({ anchorDirectory: payload.anchor,
  openDirectory(locator) { return createAuthorityDirectoryProvider({ directory: locator.endpointRef, anchor: payload.anchor, authority: payload.authority,
    onPhase(phase) { const current = readStageZero(payload.anchor); if (current.ok && ((payload.kill === 'published' && phase === 'temp' && current.value?.locator.cutoverId === payload.request.upgradeId) || (payload.kill === 'freeze' && phase === 'commit' && current.value?.locator.cutoverId !== payload.request.upgradeId))) process.kill(process.pid, 'SIGKILL'); }
  }); }
});
console.log(JSON.stringify(await adapter.transfer(payload.request, ctx)));
`
async function runChild(file: string) {
  return new Promise<{ signal: NodeJS.Signals | null; code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', childCode, file],
        { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = '',
        stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`directory fixture timeout: ${stderr}`))
      }, 30000)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (text: string) => {
        stdout += text
      })
      child.stderr.on('data', (text: string) => {
        stderr += text
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, stdout, stderr })
      })
    },
  )
}

describe('directory transfer adapter with the local persistent directory', () => {
  it.each(['freeze', 'published'] as const)(
    'probes the external commit after a real kill at %s, then cold-reopens the target',
    async (boundary) => {
      const root = mkdtempSync(join(tmpdir(), 'migration-directory-'))
      const directory = join(root, 'source'),
        anchor = join(root, 'external-anchor')
      const lock = inlineData({ lock: 'local-directory' }, 'agh.maintenance/provider-lock@1')
      const created = createDirectoryAnchor(
        anchor,
        {
          directoryId: 'directory',
          providerLockRef: lock,
          endpointRef: directory,
          epoch: 1,
          revision: 1,
          cutoverId: 'initial',
        },
        'maintainer',
      )
      expect(created.ok).toBe(true)
      const source = createAuthorityDirectoryProvider({ directory, anchor, authority })
      const route: AuthorityRoute = {
        logicalAuthorityId: 'state',
        tenantId: authority.tenantId,
        authorityEpoch: 1,
        providerBinding: {
          bindingId: 'state-binding',
          contract: 'agh.state',
          logicalName: 'state',
          providerId: 'agh.default/state',
        },
        locationRef: 'source-state',
        cohortDigest: 'ab'.repeat(32),
        cutoverId: 'initial-state',
        previous: null,
        checkpoint: {
          authorityId: 'state',
          authorityEpoch: 1,
          checkpointId: 'snapshot',
          snapshotDigest: 'cd'.repeat(32),
          recordCount: 123,
          bridgeWatermarks: [],
        },
      }
      const request: MigrationRequest = {
        upgradeId: 'directory-move',
        mode: 'explicit',
        reason: 'relocate local directory',
        policyRef: 'policy',
        target: {
          kind: 'directory',
          sourceLocatorRevision: 1,
          targetProviderLock: lock,
          targetLocationRef: 'next',
          externalJournalRef: 'external-journal',
        },
      }
      const adapter = () =>
        createDirectoryTransferAdapter({
          anchorDirectory: anchor,
          openDirectory: (locator) =>
            createAuthorityDirectoryProvider({ directory: locator.endpointRef, anchor, authority }),
        })
      try {
        expect((await source.seedRoute(route, context())).ok).toBe(true)
        const denied = await adapter().transfer(request, { ...context(), principalRef: 'stranger' })
        expect(!denied.ok && denied.error.code).toBe('denied')
        const payloadFile = join(root, 'payload.json')
        writeFileSync(
          payloadFile,
          JSON.stringify({ anchor, authority, context: context(), request, kill: boundary }),
        )
        const killed = await runChild(payloadFile)
        expect(killed.signal, killed.stderr).toBe('SIGKILL')
        const locator = readStageZero(anchor)
        expect(locator.ok && locator.value?.locator.cutoverId).toBe(
          boundary === 'published' ? request.upgradeId : 'initial',
        )
        expect(locator.ok && locator.value?.locator.epoch).toBe(boundary === 'published' ? 2 : 1)
        // A journal saying success cannot reopen the source after this externally committed CAS.
        const old = await source.read({ kind: 'authority', logicalAuthorityId: 'state' }, context())
        if (boundary === 'published') expect(!old.ok && old.error.detailCode).toBe('locator_uncertain')
        else expect(old.ok).toBe(true)
        writeFileSync(
          payloadFile,
          JSON.stringify({ anchor, authority, context: context(), request, kill: false }),
        )
        const reopened = await runChild(payloadFile)
        expect(reopened.code, reopened.stderr).toBe(0)
        expect(JSON.parse(reopened.stdout)).toMatchObject({
          ok: true,
          value: {
            state: 'committed',
            upgradeId: request.upgradeId,
            checkpointRevision: 2,
            commitRef: request.upgradeId,
          },
        })
        const probed = await adapter().probe(request, context())
        expect(probed).toEqual(JSON.parse(reopened.stdout))
        expect(await adapter().transfer(request, context())).toEqual(probed)
        const conflict = await adapter().transfer({ ...request, reason: 'different input' }, context())
        expect(!conflict.ok && conflict.error.detailCode).toBe('operation_fingerprint')
        const finalLocator = readStageZero(anchor)
        if (!finalLocator.ok || !finalLocator.value) throw new Error('missing external locator')
        const target = createAuthorityDirectoryProvider({
          directory: finalLocator.value.locator.endpointRef,
          anchor,
          authority,
        })
        try {
          const read = await target.read({ kind: 'authority', logicalAuthorityId: 'state' }, context())
          expect(read.ok && read.value.kind === 'authority' && read.value.route).toEqual(route)
        } finally {
          await target.dispose()
        }
        const opened = openBootstrapAnchor(anchor)
        if (!opened.ok) throw new Error('missing anchor')
        const journal = opened.value.readJournal(request.upgradeId)
        expect(journal.ok && journal.value).toBeTruthy()
        expect(
          opened.value.writeJournal(request.upgradeId, { upgradeId: request.upgradeId, toEpoch: 999 }).ok,
        ).toBe(true)
        const corrupt = await adapter().probe(request, context())
        expect(!corrupt.ok && corrupt.error.detailCode).toBe('external_commit_mismatch')
      } finally {
        await source.dispose()
        rmSync(root, { recursive: true, force: true })
      }
    },
    90000,
  )
})
