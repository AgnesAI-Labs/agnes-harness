import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { RuntimeWireTypes as Wire } from '@agnes/protocol/runtime'
import {
  createPackageInstallerProvider,
  type InstallOperationObservation,
  openInstallJournal,
} from '../../../src/runtime/providers/package-installer.js'

const ref = (await import(
  new URL('../../../../../examples/runtime-reference/src/providers/package-installer.js', import.meta.url)
    .href
)) as {
  createReferencePackageInstallerProvider: typeof createPackageInstallerProvider
  openReferenceInstallJournal: typeof openInstallJournal
}

const directory = process.env.INSTALLER_FIXTURE_DIRECTORY as string
const reference = process.env.INSTALLER_FIXTURE_PROVIDER === 'reference'
const journal = reference
  ? ref.openReferenceInstallJournal(join(directory, 'journal.sqlite'))
  : openInstallJournal(join(directory, 'journal.sqlite'))
const context: CallContext = {
  principalRef: 'fixture-owner',
  authorizationRef: 'fixture-authorization',
  invocationId: 'fresh-process',
  bindingId: 'fixture-binding',
  traceRef: 'fixture-trace',
  deadline: '2030-01-01T00:00:00Z',
  scope: { kind: 'installation', installationId: 'fixture-installation' },
  signal: new AbortController().signal,
}
const create = reference ? ref.createReferencePackageInstallerProvider : createPackageInstallerProvider
const provider = create({
  journal,
  currentAuthorization: async (call) => ({ ok: true, value: call.principalRef }),
  readLocalOperation: async (operation) => {
    const original = JSON.parse(
      readFileSync(join(directory, 'original-operation.json'), 'utf8'),
    ) as InstallOperationObservation
    if (operation.operationId !== original.operationId) throw new Error('original operation identity differs')
    return { ok: true, value: original }
  },
})
if (process.env.INSTALLER_FIXTURE_WRITE === '1') {
  const request = JSON.parse(
    readFileSync(join(directory, 'request.json'), 'utf8'),
  ) as Wire['ChangeProposalRequest']
  const accepted = await provider.requestChange(request, context)
  if (!accepted.ok) throw new Error(accepted.error.detailCode)
  if (process.env.INSTALLER_FIXTURE_PHASE !== 'planning' && process.env.INSTALLER_FIXTURE_PHASE) {
    const { bindInstallerFixtureOperation } = await import('./installer.js')
    const record = bindInstallerFixtureOperation(journal, accepted.value.proposalId)
    if (process.env.INSTALLER_FIXTURE_PHASE === 'applied')
      journal.compareAndSwap(accepted.value.proposalId, record.proposal.revision, {
        ...record,
        proposal: {
          ...record.proposal,
          revision: record.proposal.revision + 1,
          status: 'applied',
          resultRef: {
            authorityId: 'fixture-maintenance',
            receiptId: 'original-receipt',
            digest: '4'.repeat(64),
          },
        },
      })
  }
  process.send?.({ proposalId: accepted.value.proposalId })
  // Keep the real SQLite writer open until the parent kills this fixture.
  process.on('message', () => {})
} else {
  const result: Outcome<Wire['ChangeProposal']> = await provider.proposalStatus(
    { proposalId: process.env.INSTALLER_FIXTURE_PROPOSAL },
    context,
  )
  process.stdout.write(JSON.stringify(result))
  provider.dispose()
  journal.close()
}
