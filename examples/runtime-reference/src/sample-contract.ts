import { existsSync } from 'node:fs'
import type { BindingRef, ServiceRequirement } from '@agnes/extension-api/runtime'
import {
  type AssertionInput,
  type BuildIdentity,
  type CaseRegistration,
  SCENARIOS,
} from '@agnes/extension-api/testkit'
import { type NoteStore, openNoteStore, refuseNote } from './sample-provider.js'

export const SAMPLE_CONTRACT = 'sample.durable-note'
export const SAMPLE_PROVIDER_ID = 'sample-note'

const build: BuildIdentity = {
  codeSha: 'sample-code',
  buildDigest: 'sample-build',
  lockDigest: 'sample-lock',
  specVersion: 'sample-spec',
  sdkVersion: 'sample-sdk',
  sdkDigest: 'sample-sdk-digest',
  platform: 'sample-platform',
}

const reuse: AssertionInput['reuse'] = {
  scope: 'workspace',
  methodKind: 'compute',
  lifecycle: 'call',
  undeclaredConnection: false,
}

function row(
  id: string,
  lifecycle: AssertionInput['reuse']['lifecycle'],
  status: AssertionInput['status'],
): AssertionInput {
  return {
    id,
    providerDigest: 'sample-note-digest',
    recipe: 'examples/runtime-reference/src/sample-provider.ts',
    features: ['write'],
    build,
    consumer: 'sample-consumer',
    command: 'sample-contract',
    status,
    configDigest: 'sample-config',
    releaseSetDigest: 'sample-release',
    attachmentDigest: null,
    fixture: null,
    sharedEvidenceId: null,
    reuse: { ...reuse, lifecycle },
    perImplementation: true,
    gate: null,
  }
}

const requirement: ServiceRequirement = {
  contract: SAMPLE_CONTRACT,
  major: 1,
  logicalName: 'note',
  features: ['write'],
  scope: 'workspace',
  optional: false,
}

const binding: BindingRef = {
  bindingId: 'sample-binding',
  contract: SAMPLE_CONTRACT,
  logicalName: 'note',
  providerId: SAMPLE_PROVIDER_ID,
}

// Copy these six registrations for a catalog contract.
// Set recipe to providerFileForContract(contract) and pass that provider to createReferenceRegistry.
// Cite shared evidence only when the sdk digest, scope, method kind and lifecycle match,
// and neither side opens an undeclared connection. A private store stays per implementation.
export function sampleContractCases(databasePath: string): {
  readonly cases: readonly CaseRegistration[]
  close(): void
} {
  let store: NoteStore | null = openNoteStore(databasePath)
  const current = (): NoteStore => {
    if (store === null) throw new Error('store is closed')
    return store
  }
  const passed = (ok: boolean) => (ok ? 'passed' : 'failed')
  const cases: CaseRegistration[] = SCENARIOS.map((scenario) => ({
    contract: SAMPLE_CONTRACT,
    scenario,
    qualification: 'required',
    providerId: SAMPLE_PROVIDER_ID,
    run(context) {
      if (scenario === 'select') {
        context.container.register({ requirement, binding })
        const selected = context.container.dependencies.get(requirement)
        const providerId = selected.ok ? selected.value.binding.providerId : ''
        return row('sample-select', 'call', passed(providerId === SAMPLE_PROVIDER_ID))
      }
      if (scenario === 'normal') {
        current().commit({ id: 'note', body: 'hello', revision: 1 })
        const note = current().read('note')
        return row('sample-normal', 'call', passed(note?.body === 'hello' && note.revision === 1))
      }
      if (scenario === 'deny') {
        const refused = refuseNote('session', [])
        if (!refused) current().commit({ id: 'secret', body: 'nope', revision: 1 })
        return row('sample-deny', 'call', passed(refused && current().read('secret') === null))
      }
      if (scenario === 'cancel') {
        current().rollback({ id: 'note', body: 'cancelled', revision: 2 })
        const note = current().read('note')
        return row('sample-cancel', 'cancel', passed(note?.body === 'hello' && note.revision === 1))
      }
      if (scenario === 'recover') {
        current().close()
        store = openNoteStore(databasePath)
        const note = current().read('note')
        return row('sample-recover', 'recover', passed(note?.body === 'hello' && existsSync(databasePath)))
      }
      current().close()
      let closed = false
      try {
        current().read('note')
      } catch (error) {
        closed = error instanceof Error && /store is closed/.test(error.message)
      }
      store = null
      return row('sample-dispose', 'dispose', passed(closed && existsSync(databasePath)))
    },
  }))
  return {
    cases,
    close() {
      store?.close()
      store = null
    },
  }
}
