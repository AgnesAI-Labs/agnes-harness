import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindInteractionContract } from '../../../../examples/runtime-reference/src/providers/interaction-contract.js'
import type { Outcome } from '../../../../packages/extension-api/src/runtime/index.js'
import {
  type InteractionContractPort,
  registerInteractionContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/interaction.js'
import type { RuntimeInboxFixture } from '../../../../packages/extension-api/testkit/runtime/fixtures.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { createInteractionService } from '../../../../packages/host/src/runtime/providers/interaction.js'
import { createRuntimeStateStore } from '../../../../packages/host/src/runtime/providers/state.js'
import type { RuntimeApprovalJointOwner } from '../../../../packages/host/src/runtime/state/transactions.js'
import { interactionStateFixture } from '../../../../packages/host/test/runtime-state-interaction-read-fixture.js'
import { canonicalJsonDigest, RuntimeSchemaRefs } from '../../../../packages/protocol/src/runtime/index.js'
import {
  getConformanceBuildIdentity,
  withConformanceBuild,
  withDeploymentStandIns,
} from '../build-identity.js'

const CONTRACT = 'agh.interaction'
const PROVIDERS = ['default', 'reference'] as const
const RECIPE = 'packages/host/src/runtime/providers/interaction.ts'
const STAND_INS =
  "questions, responder identities and the State database are the Host State test fixture's, and the wakes State commits as inbox records are handed to the suite's inbox fixture; not evidence for the Host authorization driver or daemon composition"
// Its own logical name, so the run's one test service container holds it beside the reference store.
const LOGICAL_NAME = 'interaction-default'
const NOW = Date.parse('2026-04-01T00:00:00.000Z')
// One question each for normal and deny, three for cancel.
const QUESTIONS = 5

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const sha256 = (path: string) =>
  createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex')
const code = (outcome: Outcome<unknown>) => (outcome.ok ? null : outcome.error.detailCode)
function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.error.detailCode}: ${outcome.error.message}`)
  return outcome.value
}
/** Open descriptors of this process, or null where there is no `/dev/fd` to list them (Windows). */
const openHandles = () => (existsSync('/dev/fd') ? readdirSync('/dev/fd').length : null)
function waiter(inbox: RuntimeInboxFixture, deliveryKey: string) {
  const seen = { woken: 0 }
  inbox.registerWaiter(deliveryKey, () => void seen.woken++)
  return seen
}

/** The Host default provider over the State fixture, driven through the six scenarios the suite judges. */
async function defaultInteractionPort(): Promise<InteractionContractPort> {
  const f = await interactionStateFixture({ actions: QUESTIONS })
  // A second current identity, which the questions do not list as a responder.
  const stranger = Object.freeze({})
  const joint: RuntimeApprovalJointOwner = {
    ...f.joint,
    currentResponder(context, capability) {
      if (capability !== stranger) return f.joint.currentResponder(context, capability)
      return { ...f.joint.currentResponder(context, f.capability), actorRef: 'stranger' }
    },
  }
  const options = {
    file: f.file,
    authority: { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 },
    now: () => NOW,
    interactionRead: f.readOwner,
    approvalJoint: joint,
  }
  const store = createRuntimeStateStore(options)
  const provider = (capability: object) =>
    createInteractionService({ store, responder: (context) => (context === f.context ? capability : null) })
  const service = provider(f.capability)
  const questions = [...f.approvals]
  const intents = new Map<string, string>()
  const ask = async () => {
    const next = questions.shift()
    if (next === undefined) throw new Error('the State fixture has no question left')
    const record = must(
      await service.prepareApproval({
        request: next.question,
        owner: { runId: 'run', actionId: next.actionId },
        preparation: next.prepare,
        context: f.context,
      }),
    )
    intents.set(record.interactionId, next.question.intentDigest)
    return record
  }
  const answer = (interactionId: string, responseId: string, extra: Record<string, unknown> = {}) => ({
    interactionId,
    responseId,
    expectedVersion: 1,
    decision: 'approve',
    intentDigest: intents.get(interactionId),
    ...extra,
  })
  // State writes each wake as an inbox record in the answer's own commit; every committed one is handed over.
  const deliver = (inbox: RuntimeInboxFixture, deliveryKey: string) => {
    const { n } = f.owner.db
      .prepare(
        "SELECT COUNT(*) AS n FROM runtime_record_heads h JOIN runtime_version_bodies b USING(record_id,record_revision) WHERE json_extract(h.schema_json,'$.typeId')=? AND json_extract(b.value_json,'$.eventId')=?",
      )
      .get(RuntimeSchemaRefs.InboxRecord.typeId, deliveryKey) as { n: number }
    for (let i = 0; i < n; i++) inbox.notify(deliveryKey)
  }
  return {
    async select() {
      return {
        binding: {
          requirement: {
            contract: CONTRACT,
            major: 1,
            logicalName: LOGICAL_NAME,
            features: [],
            scope: 'run',
            optional: false,
          },
          binding: {
            bindingId: 'default-interaction',
            contract: CONTRACT,
            logicalName: LOGICAL_NAME,
            providerId: 'default',
          },
        },
      }
    },
    async normal({ inbox }) {
      const { interactionId } = await ask()
      const seen = waiter(inbox, `${interactionId}@2`)
      const request = answer(interactionId, 'port-normal')
      const statuses: string[] = []
      for (let i = 0; i < 2; i++)
        statuses.push(must(await service.respondApproval(request, f.context)).status)
      deliver(inbox, `${interactionId}@2`)
      deliver(inbox, `${interactionId}@2`)
      statuses.push(must(await service.responseStatus('port-normal', f.context)).status)
      return { statuses, record: must(await service.read(interactionId, f.context)), woken: seen.woken }
    },
    async deny({ inbox }) {
      const { interactionId } = await ask()
      const seen = waiter(inbox, `${interactionId}@2`)
      const refusals = [
        await provider(stranger).respondApproval(answer(interactionId, 'deny-1'), f.context),
        await service.respondApproval(
          answer(interactionId, 'deny-2', { intentDigest: 'e'.repeat(64) }),
          f.context,
        ),
        await service.respondApproval(answer(interactionId, 'deny-3', { expectedVersion: 7 }), f.context),
        await service.respondApproval(answer(interactionId, 'deny-4', { unknownField: true }), f.context),
        await service.respondApproval(
          answer(interactionId, 'deny-5', { grantScope: 'permanent' }),
          f.context,
        ),
      ].map(code)
      deliver(inbox, `${interactionId}@2`)
      return { refusals, record: must(await service.read(interactionId, f.context)), woken: seen.woken }
    },
    // The default refuses cancel and expire, so the late answers this scenario judges are never sent.
    async cancel() {
      const [first, second] = [await ask(), await ask(), await ask()].map((record) => record.interactionId)
      const cancel = await service.cancel({ interactionId: first, expectedVersion: 1 }, f.context)
      const expire = await service.expire({ interactionId: second, expectedVersion: 1 }, f.context)
      throw new Error(`not run: cancel refused as ${code(cancel)}, expire refused as ${code(expire)}`)
    },
    // The suite kills a provider process between an answer and its wake delivery. The default runs in
    // the Host process and commits the wake with the answer, so there is no such process or step.
    async recover() {
      throw new Error(
        'not run: the default provider has no process of its own to kill, and its wake commits with the answer',
      )
    },
    async dispose() {
      store.close()
      const refused = !(await service.read('port-1', f.context)).ok
      const garbage = `${f.file}.garbage`
      writeFileSync(garbage, 'not an interaction store\n'.repeat(200))
      const baseline = openHandles()
      let mountRefused = false
      try {
        createRuntimeStateStore({ ...options, file: garbage }).close()
      } catch {
        mountRefused = true
      }
      const afterFailedMount = openHandles()
      createRuntimeStateStore(options).close()
      const afterClose = openHandles()
      return {
        refused,
        storeRemains: existsSync(f.file),
        mountRefused,
        handles: { baseline, afterFailedMount, afterClose },
      }
    },
  }
}

/** Registers the six interaction cases for the Host default provider on the State fixture's database. */
async function bindDefaultInteractionContract(harness: ConformanceHarness, command: string): Promise<void> {
  registerInteractionContract(withDeploymentStandIns(withConformanceBuild(harness), STAND_INS), {
    providerId: 'default',
    recipe: RECIPE,
    command,
    build: getConformanceBuildIdentity(),
    providerDigest: sha256(RECIPE),
    configDigest: canonicalJsonDigest({ logicalName: LOGICAL_NAME, questions: QUESTIONS }),
    releaseSetDigest: sha256('packages/host/package.json'),
    port: await defaultInteractionPort(),
  })
}

// The Host default provider, over the State fixture's database, and the reference store bind here. The
// runner has no teardown, so the databases live until the process exits.
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes(CONTRACT))
    return { contracts: [], providers: [] }
  const providers = PROVIDERS.filter((providerId) => request.providers.includes(providerId))
  for (const providerId of providers) {
    if (providerId === 'reference')
      bindInteractionContract(withConformanceBuild(harness), request.command, { providerId })
    else await bindDefaultInteractionContract(harness, request.command)
  }
  return { contracts: [CONTRACT], providers }
}
