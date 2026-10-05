import type {
  ActionFrame,
  CallContext,
  LoopReadPorts,
  Outcome,
  PreparedAction,
} from '@agnes/extension-api/runtime'
import { validateRequestMedia } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import type { ScenarioName } from '../evidence.js'
import type { MediaContractFixture } from './media-fixture.js'

function assert(condition: unknown, id: string): asserts condition {
  if (!condition) throw new Error(`Media contract assertion failed: ${id}`)
}
const digest = (value: unknown) => canonicalJsonDigest(value as W.JsonValue)
const code = (t: W.ProviderTransition) => (t.next.kind === 'fail' ? t.next.error.code : t.next.kind)

/** Contract-level reading of a result; it shares nothing with either implementation. */
function checkResult(
  plan: W.MediaPlan,
  transition: W.ProviderTransition,
  expect: {
    converted: boolean
    text?: string
    child?: { actionId: string; usage: readonly W.UsageFactRef[] }
  },
) {
  assert(transition.next.kind === 'complete' && transition.next.output.kind === 'inline', 'complete-inline')
  const parsed = validateRuntime('PreparedMedia', transition.next.output.value)
  assert(parsed.ok, 'prepared-media-schema')
  const media = parsed.value
  assert(digest(media.sourceRefs) === digest(plan.sourceRefs), 'source-refs')
  assert(digest(media.provenance.producer) === digest(plan.provider), 'producer')
  assert(media.trust !== 'system', 'trust-not-system')
  const manifest = media.contentRefs[0]
  assert(manifest?.kind === 'inline' && manifest.schema.typeId === 'agh.media/manifest@1', 'manifest-first')
  const body = manifest.value as Record<string, unknown>
  assert(body.planDigest === digest(plan), 'manifest-plan')
  assert(['native', 'converted', 'degraded', 'omitted'].includes(body.kind as string), 'manifest-kind')
  assert(validateRequestMedia(body.header).ok, 'manifest-header')
  assert(typeof body.mediaHash === 'string' && /^[0-9a-f]{64}$/.test(body.mediaHash), 'manifest-hash')
  assert(Array.isArray(body.sources) && body.sources.length === plan.sourceRefs.length, 'manifest-sources')
  if (!expect.converted) {
    assert(media.transformChain.length === 0 && media.usageRefs.length === 0, 'native-has-no-chain-or-usage')
    const blobs = media.contentRefs.slice(1)
    assert(
      blobs.length > 0 &&
        blobs.every(
          (ref) =>
            ref.kind === 'blob' &&
            plan.sourceRefs.some((s) => s.kind === 'blob' && digest(s.value) === digest(ref.blob)),
        ),
      'native-blobs-are-sources',
    )
  } else {
    assert(media.trust === 'derived', 'converted-is-derived')
    assert(media.transformChain.length === 1, 'one-link')
    const link = media.transformChain[0]!
    assert(
      link.actionId === expect.child!.actionId &&
        link.inputDigest === plan.sourceDigest &&
        digest(link.transformSchema) === digest(plan.transformSchema),
      'link-identity',
    )
    assert(digest(media.usageRefs) === digest(expect.child!.usage), 'usage-is-the-childs-own')
    const derived = media.contentRefs[1]
    assert(
      media.contentRefs.length === 2 && derived?.kind === 'inline' && link.outputDigest === derived.digest,
      'derived-content',
    )
    assert(JSON.stringify(derived.value).includes(expect.text!), 'derived-text')
  }
  return media
}

export async function runMediaContractScenario(
  scenario: ScenarioName,
  open: () => Promise<MediaContractFixture>,
) {
  let fixture = await open()
  let provider = await fixture.factory.create(
    fixture.configuration,
    fixture.dependencies,
    fixture.factoryContext,
  )
  const handler = async () => {
    const action = await provider.actions?.prepare?.create(fixture.scope)
    assert(action?.kind === 'composite', 'managed-composite-prepare')
    return action
  }
  const receiptsOf = (receipt: ActionFrame['receipts']['items'][number]): ActionFrame['receipts'] => ({
    items: [receipt],
    snapshot: 'published',
    nextCursor: null,
    complete: true,
  })
  /** start -> continue -> resume -> one child -> (caller dispatches) */
  async function toChild(action: Awaited<ReturnType<typeof handler>>) {
    const first = await action.start(fixture.convertFrame, fixture.ports)
    assert(first.children.length === 0 && first.next.kind === 'continue', 'start-is-preflight-only')
    assert(fixture.computeCalls() === 0, 'no-compute-before-the-second-step')
    const frame1: ActionFrame = {
      ...fixture.convertFrame,
      providerRevision: 1,
      continuation: first.continuation,
    }
    const second = await action.resume(frame1, fixture.ports)
    assert(second.children.length === 1 && second.next.kind === 'wait', 'one-child-then-wait')
    const child = second.children[0]!
    assert(
      child.method === 'infer' && child.retry.mode === 'never' && child.obligation === 'mandatory',
      'child-shape',
    )
    return { frame1, second, child }
  }
  try {
    assert((await provider.ready(fixture.call)).ok, 'ready')
    assert(validateRuntime('ProviderDescriptor', fixture.factory.descriptor).ok, 'descriptor')
    assert(fixture.factory.descriptor.contract === 'agh.media', 'contract')
    const action = await handler()
    try {
      if (scenario === 'select') {
        const d = fixture.factory.descriptor
        assert(
          d.operations.length === 1 &&
            d.operations[0]?.method === 'prepare' &&
            d.operations[0]?.kind === 'action',
          'exact-operation',
        )
        assert(d.recovery === 'R2' && d.stateCodecs.length === 1, 'recovery-and-codec')
        assert(!d.features.includes('authority-transfer.v1'), 'no-authority-transfer')
        assert(
          provider.actions?.prepare?.kind === 'composite' && provider.actions.prepare.stateCodec !== null,
          'composite-with-codec',
        )
      } else if (scenario === 'normal') {
        const native = await action.start(fixture.nativeFrame, fixture.ports)
        assert(native.children.length === 0, 'native-no-child')
        assert(
          fixture.computeCalls() === 0 && fixture.childrenPrepared() === 0 && fixture.visionRequests() === 0,
          'native-no-conversion',
        )
        checkResult(fixture.plans.native, native, { converted: false })
        const { frame1, second, child } = await toChild(action)
        const receipt = await fixture.dispatch(child)
        assert(fixture.visionRequests() === 1, 'exactly-one-vision-request')
        const done = await action.resume(
          {
            ...frame1,
            providerRevision: 2,
            continuation: second.continuation,
            receipts: receiptsOf(receipt),
          },
          fixture.ports,
        )
        assert(done.children.length === 0, 'completion-has-no-child')
        checkResult(fixture.plans.convert, done, {
          converted: true,
          text: fixture.visionText,
          child: { actionId: receipt.actionId, usage: fixture.visionUsage },
        })
        assert(fixture.computeCalls() === 1 && fixture.childrenPrepared() === 1, 'one-prepare-one-child')
      } else if (scenario === 'deny') {
        const foreign = await action.start(fixture.foreignFrame, fixture.ports)
        assert(code(foreign) === 'denied' && foreign.children.length === 0, 'foreign-plan-denied')
        await fixture.withdrawPermission()
        for (const frame of [fixture.nativeFrame, fixture.convertFrame]) {
          const refused = await action.start(frame, fixture.ports)
          assert(code(refused) === 'denied' && refused.children.length === 0, 'withdrawn-permission-denied')
        }
        await fixture.revoke()
        for (const frame of [fixture.nativeFrame, fixture.convertFrame]) {
          const refused = await action.start(frame, fixture.ports)
          assert(code(refused) === 'denied' && refused.children.length === 0, 'revoked-denied')
        }
        assert(
          fixture.computeCalls() === 0 && fixture.childrenPrepared() === 0 && fixture.visionRequests() === 0,
          'denied-no-effect',
        )
      } else if (scenario === 'cancel') {
        const aborted = new AbortController()
        aborted.abort()
        const dead = await provider.actions!.prepare!.create({ ...fixture.scope, signal: aborted.signal })
        assert(dead.kind === 'composite', 'composite')
        const refused = await dead.start(fixture.convertFrame, fixture.ports)
        assert(code(refused) === 'cancelled' && refused.children.length === 0, 'pre-cancelled')
        const { frame1, second, child } = await toChild(action)
        const receipt = await fixture.dispatch(child)
        const controller = new AbortController()
        const live = await provider.actions!.prepare!.create({ ...fixture.scope, signal: controller.signal })
        assert(live.kind === 'composite', 'composite')
        let began = () => {}
        const waiting = new Promise<void>((resolve) => {
          began = resolve
        })
        const pending = live.resume(
          {
            ...frame1,
            providerRevision: 2,
            continuation: second.continuation,
            receipts: receiptsOf(receipt),
          },
          {
            ...fixture.ports,
            query: async () => {
              began()
              return new Promise<Outcome<W.QueryReply>>(() => {})
            },
          },
        )
        await waiting
        controller.abort()
        const interrupted = await pending
        assert(
          interrupted.next.kind === 'fail' && interrupted.children.length === 0,
          'cancelled-while-reading-the-child-result',
        )
        assert(
          fixture.visionRequests() === 1 && fixture.childrenPrepared() === 1,
          'cancel-creates-nothing-new',
        )
      } else if (scenario === 'recover') {
        const { frame1, second, child } = await toChild(action)
        const pending = await action.resume(
          { ...frame1, providerRevision: 2, continuation: second.continuation },
          fixture.ports,
        )
        assert(pending.children.length === 0 && pending.next.kind === 'wait', 'waiting-creates-no-child')
        assert(fixture.childrenPrepared() === 1, 'waiting-prepares-nothing')
        const receipt = await fixture.dispatch(child)
        const frame2: ActionFrame = {
          ...frame1,
          providerRevision: 2,
          continuation: second.continuation,
          receipts: receiptsOf(receipt),
        }
        const warm = await action.resume(frame2, fixture.ports)
        await action.close('shutdown')
        await provider.close('shutdown')
        fixture = await fixture.restart()
        provider = await fixture.factory.create(
          fixture.configuration,
          fixture.dependencies,
          fixture.factoryContext,
        )
        assert((await provider.ready(fixture.call)).ok, 'reopened-ready')
        const cold = await (await handler()).resume(frame2, fixture.ports)
        assert(cold.children.length === 0, 'cold-no-new-child')
        assert(fixture.visionRequests() === 1, 'cold-no-new-vision-request')
        assert(fixture.childrenPrepared() === 1, 'cold-no-new-prepare-spec')
        assert(digest(cold.next) === digest(warm.next), 'cold-same-result')
        checkResult(fixture.plans.convert, cold, {
          converted: true,
          text: fixture.visionText,
          child: { actionId: receipt.actionId, usage: fixture.visionUsage },
        })
      } else {
        await provider.drain(fixture.call.deadline, fixture.call)
        const drained = await action.start(fixture.nativeFrame, fixture.ports)
        assert(code(drained) === 'denied', 'drained-denies-new-work')
        await provider.close('shutdown')
        const closed = await action.start(fixture.nativeFrame, fixture.ports)
        assert(
          code(closed) === 'denied' && !(await provider.ready(fixture.call)).ok,
          'closed-old-reference-denied',
        )
        assert(fixture.computeCalls() === 0 && fixture.visionRequests() === 0, 'disposed-no-effect')
      }
    } finally {
      await action.close('completed')
    }
    return {
      providerDigest: fixture.factory.descriptor.packageDigest,
      inputDigest: digest(fixture.convertFrame.input),
    }
  } finally {
    await provider.close('shutdown')
    await fixture.close()
  }
}
