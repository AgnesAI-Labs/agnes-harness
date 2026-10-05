import type {
  CallContext,
  FactoryContext,
  LoopProvider,
  LoopReadPorts,
  ProviderFactory,
  ScopedDependencies,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

/** Restricted peers exercise planning and receipt observation; they are not State/Supervisor owners. */
export interface LoopContractFixture {
  factory: ProviderFactory<LoopProvider>
  config: W.DataRef
  dependencies: ScopedDependencies
  factoryContext: FactoryContext
  context: CallContext
  frame: W.RunFrame
  ports: LoopReadPorts
  nextFrame(transition: W.LoopTransition): W.RunFrame
  accept(action: W.PreparedAction): Promise<void>
  revoke(): void
  cancel(): void
  /** Must use a public State commit/read consumer across SIGKILL; an in-memory fixture cannot implement this. */
  cold(pending: W.LoopTransition): Promise<{
    killedPid: number
    restoredPid: number
    signal: 'SIGKILL'
    stateConsumer: 'public-state-control'
    transition: W.LoopTransition
  }>
  close(): Promise<void>
}
function require(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(`Loop slice contract: ${detail}`)
}
export async function runLoopContractScenario(
  scenario: ScenarioName,
  open: () => Promise<LoopContractFixture>,
) {
  const fixture = await open()
  const provider = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)
  try {
    require((await provider.ready(fixture.context)).ok, 'ready')
    if (scenario === 'deny' || scenario === 'cancel') {
      if (scenario === 'deny') fixture.revoke()
      else fixture.cancel()
      const transition = await provider.start(fixture.frame, fixture.ports)
      require(transition.next.kind === 'fail' &&
        transition.next.error.code === (scenario === 'deny' ? 'denied' : 'cancelled') &&
        transition.actions.length === 0, 'current refusal')
    } else if (scenario === 'dispose') {
      require((await provider.drain(fixture.context.deadline, fixture.context)).ok, 'drain')
      require((await provider.start(fixture.frame, fixture.ports)).next.kind === 'fail', 'drained')
      await provider.close('shutdown')
      require(!(await provider.ready(fixture.context)).ok, 'cannot revive')
    } else if (scenario === 'recover') {
      const pending = await provider.start(fixture.frame, fixture.ports)
      require(pending.next.kind === 'wait' &&
        pending.actions.length === 1 &&
        pending.continuation, 'original intent for State commit')
      const cold = await fixture.cold(pending)
      require(cold.killedPid > 0 &&
        cold.restoredPid > 0 &&
        cold.killedPid !== cold.restoredPid &&
        cold.signal === 'SIGKILL' &&
        cold.stateConsumer === 'public-state-control', 'actual cold State consumer')
      require(cold.transition.next.kind === 'wait' &&
        cold.transition.actions.length === 0, 'original pending intent after cold resume')
      require(cold.transition.continuation &&
        canonicalJsonDigest(cold.transition.continuation.data) ===
          canonicalJsonDigest(pending.continuation.data) &&
        canonicalJsonDigest(cold.transition.next) ===
          canonicalJsonDigest(pending.next), 'original persisted intent and deadline')
    } else {
      let frame = fixture.frame
      let transition = await provider.start(frame, fixture.ports)
      require(validateRuntime('LoopTransition', transition).ok &&
        transition.actions.length === 1 &&
        transition.actions[0]?.key === 'first-model' &&
        transition.next.kind === 'wait', 'first model')
      if (scenario === 'normal') {
        for (const stage of ['tool', 'second-model', 'complete']) {
          const action = transition.actions[0]
          require(action, 'pending action')
          await fixture.accept(action)
          frame = fixture.nextFrame(transition)
          transition = await provider.resume(frame, fixture.ports)
          require(validateRuntime('LoopTransition', transition).ok, 'official transition')
          if (stage === 'complete')
            require(transition.next.kind === 'complete' && transition.actions.length === 0, 'terminal')
          else
            require(transition.next.kind === 'wait' &&
              transition.actions.length === 1 &&
              transition.actions[0]?.key === stage, stage)
        }
      }
    }
    return {
      providerDigest: fixture.factory.descriptor.packageDigest,
      configDigest: fixture.config.kind === 'inline' ? fixture.config.digest : fixture.config.blob.digest,
    }
  } finally {
    await provider.close('shutdown')
    await fixture.close()
  }
}
/** Six named cases remain required. The restricted binding deliberately fails recover until State supplies the consumer. */
export function registerLoopContract(
  harness: ConformanceHarness,
  binding: {
    providerId: string
    build: BuildIdentity
    command: string
    open: () => Promise<LoopContractFixture>
  },
) {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.loop',
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run() {
        let proof: { providerDigest: W.Digest; configDigest: W.Digest } | undefined
        let status: 'passed' | 'failed' = 'passed'
        let diagnostic =
          'Background planning slice only. Conversation codec and production State/Supervisor assembly remain unavailable; no full-card claim.'
        try {
          proof = await runLoopContractScenario(scenario, async () => {
            const fixture = await binding.open()
            proof = {
              providerDigest: fixture.factory.descriptor.packageDigest,
              configDigest:
                fixture.config.kind === 'inline' ? fixture.config.digest : fixture.config.blob.digest,
            }
            return fixture
          })
        } catch (error) {
          if (
            scenario !== 'recover' ||
            !(error instanceof Error) ||
            !error.message.startsWith('loop_cold_state_consumer_unavailable') ||
            !proof
          )
            throw error
          status = 'failed'
          diagnostic = error.message
        }
        require(proof, 'implementation evidence')
        return {
          id: `agh.loop/${binding.providerId}/${scenario}/two-model-text-tool`,
          ...proof,
          recipe: 'two-model-text-tool-background-slice',
          features: [],
          build: binding.build,
          consumer: 'public-loop-spi-restricted-peers',
          command: binding.command,
          status,
          diagnostic,
          releaseSetDigest: canonicalJsonDigest({ slice: 'two-model-text-tool' }),
          attachmentDigest: null,
          fixture: 'test-service-container',
          sharedEvidenceId: null,
          perImplementation: true,
          gate: null,
        }
      },
    })
}
