import type {
  LoopCheckpoint,
  LoopCheckpointCodec,
  LoopContext,
  LoopDriver,
  LoopFactory,
} from '@agnes/extension-api'
import { validateOpState } from '@agnes/protocol'
import type { Inbox } from '../reduce/shapes.js'
import { claimFrom, inboxEvent } from '../step/inbox.js'
import { withPhase } from '../step/op-state.js'
import type { SessionImpl, StepOutcome } from '../step/session.js'

export const DEFAULT_LOOP = Object.freeze({ id: 'agnes.default', version: '1.0.0' })

/** Private operation ports for the existing default algorithm, fitted by the Session facade. */
export interface DefaultLoopPorts {
  session: Pick<
    SessionImpl,
    | 'op'
    | 'rehydrateTurn'
    | 'turn'
    | 'acceptInput'
    | 'runInference'
    | 'runToolsPhase'
    | 'runCompaction'
    | 'runDeferred'
    | 'latest'
    | 'transition'
    | 'ev'
    | 'lane'
    | 'd'
    | 'endTurn'
  >
  continueParked(): Promise<'opened' | 'waiting' | 'blocked' | false>
  finishAborted(): Promise<StepOutcome>
  checkpoint(): Promise<StepOutcome>
}
const portsFor = new WeakMap<LoopContext, DefaultLoopPorts>()
export function bindDefaultLoopPorts(ctx: LoopContext, ports: DefaultLoopPorts): void {
  portsFor.set(ctx, ports)
}
const codec: LoopCheckpointCodec = {
  version: 1,
  encode: (state) => ({ codecVersion: 1, state: structuredClone(state) }),
  decode(checkpoint) {
    if (checkpoint.codecVersion !== 1)
      throw new Error(`Loop checkpoint codec version ${checkpoint.codecVersion} is unsupported; expected 1`)
    if (!validateOpState(checkpoint.state).ok) throw new Error('Invalid default loop checkpoint')
    return structuredClone(checkpoint.state)
  },
}

class DefaultLoopDriver implements LoopDriver {
  constructor(private readonly ports: DefaultLoopPorts) {}
  cancel(): void {}
  dispose(): void {}
  checkpoint(): LoopCheckpoint {
    // The default loop's durable program counter remains the existing Core op register.
    return codec.encode(this.ports.session.op())
  }
  async step(_signal: AbortSignal): Promise<StepOutcome> {
    const ports = this.ports
    const s = ports.session
    const op = s.op()
    if (!op) {
      const continued = await ports.continueParked()
      if (continued === 'opened') return { phase: s.op()?.phase.kind ?? 'checkpoint' }
      if (continued === 'blocked') return { phase: 'terminal', reason: 'blocked' }
      if (continued === 'waiting') return { phase: 'terminal', reason: 'parked' }
      // A decided parked continuation is ledger work already owed by this session. It is checked
      // before the queue so a newly enqueued prompt cannot open a different turn and starve it. An
      // undecided ask still yields false above and retains the existing next-turn input policy.
      if (await s.acceptInput()) return { phase: 'checkpoint' }
      return { phase: 'idle' }
    }
    if (!s.turn) await s.rehydrateTurn(op)
    // A cancellation is a decision already on the ledger, and every phase owes the same thing after
    // it: answer whatever the cancel stopped, then end the turn. Handling it here rather than inside
    // each phase means a cancel landing between two phases is not waited out by the phase it lands
    // in front of, and no phase starts a model request or a tool once one has been recorded.
    if (op.control.status === 'cancel_requested') return ports.finishAborted()
    switch (op.phase.kind) {
      case 'checkpoint':
        return ports.checkpoint()
      case 'inference':
        return s.runInference()
      case 'tools':
        return s.runToolsPhase()
      case 'compaction':
        return s.runCompaction()
      case 'deferred':
        return s.runDeferred()
      default: {
        // failure_drain: a queued steer is a chance for the operator to redirect rather than lose
        // the turn, and only with nothing queued does the turn end on the error it drained on.
        const claimed = claimFrom(s.latest('inbox') as Inbox | undefined, 'next-step')
        if (claimed) {
          await s.transition(
            [
              inboxEvent(s.lane, s.d.actor, claimed.rest),
              s.ev(
                'user/message',
                { content: claimed.item.content, kind: claimed.item.kind ?? 'steer' },
                {
                  origin: 'principal',
                  trust: claimed.item.trust ?? 'trusted',
                  actor: claimed.item.actor,
                },
              ),
            ],
            withPhase(op, {
              kind: 'checkpoint',
              continuation: 'need_assistant',
              triggerSeq: op.meta.triggerSeq,
              skipInboxOnce: true,
            }),
          )
          return { phase: 'checkpoint' }
        }
        const reason = op.phase.error.code === 'ABORTED' ? 'aborted' : 'error'
        await s.endTurn(reason, { error: op.phase.error })
        return { phase: 'terminal', reason }
      }
    }
  }
}

function create(ctx: LoopContext): LoopDriver {
  const ports = portsFor.get(ctx)
  if (!ports) throw new Error('Default loop operation ports are missing')
  return new DefaultLoopDriver(ports)
}
export const defaultLoopFactory: LoopFactory = {
  ...DEFAULT_LOOP,
  capabilities: ['model', 'tools', 'multimodal', 'compaction', 'children', 'park', 'recovery'],
  codec,
  create,
  resume(ctx, checkpoint) {
    codec.decode(checkpoint)
    return create(ctx)
  },
}
