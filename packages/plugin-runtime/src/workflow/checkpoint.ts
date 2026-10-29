import type { LoopCheckpointCodec, LoopInput } from '@agnes/extension-api'
import type { JsonValue, WorkflowCheckpointState, WorkflowData, WorkflowOptions } from './types.js'

export const object = (value: unknown): value is Record<string, JsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function isInput(value: unknown): value is LoopInput {
  if (!object(value) || !object(value.actor)) return false
  return (
    typeof value.id === 'string' &&
    !!value.id &&
    Number.isSafeInteger(value.turnId) &&
    ['prompt', 'steer', 'follow_up'].includes(String(value.kind)) &&
    ['trusted', 'untrusted'].includes(String(value.trust)) &&
    Array.isArray(value.content) &&
    value.content.every((block) => object(block) && typeof block.type === 'string') &&
    (value.origin === undefined || ['principal', 'system'].includes(String(value.origin))) &&
    (value.system === undefined ||
      (value.origin === 'system' &&
        object(value.system) &&
        typeof value.system.source === 'string' &&
        typeof value.system.type === 'string' &&
        typeof value.system.summary === 'string' &&
        Object.hasOwn(value.system, 'data')))
  )
}

export function workflowCheckpoint(options: WorkflowOptions, stageCount: number, settings: WorkflowData) {
  const initial = (): WorkflowCheckpointState => ({
    workflow: options.id,
    index: 0,
    stageCount,
    data: {},
    input: '',
    settings: structuredClone(settings),
    stageInput: null,
    inputQueue: [],
    pending: false,
    approvalWaiting: false,
    approvalCall: null,
    explanation: null,
    waiting: null,
    confirmed: -1,
    outputKey: '',
    completed: false,
  })
  const codec: LoopCheckpointCodec<WorkflowCheckpointState> = {
    version: 1,
    encode(state) {
      // Public inputs and business state cross the same JSON checkpoint boundary as the ledger.
      return { codecVersion: 1, state: JSON.parse(JSON.stringify(state)) }
    },
    decode(checkpoint) {
      if (checkpoint.codecVersion !== 1)
        throw new Error(`Loop checkpoint codec version ${checkpoint.codecVersion} is unsupported; expected 1`)
      const state = structuredClone(checkpoint.state)
      if (
        !object(state) ||
        state.workflow !== options.id ||
        typeof state.index !== 'number' ||
        !Number.isSafeInteger(state.index) ||
        state.index < 0 ||
        state.index > stageCount ||
        !object(state.data) ||
        typeof state.input !== 'string' ||
        !object(state.settings) ||
        typeof state.pending !== 'boolean' ||
        typeof state.approvalWaiting !== 'boolean' ||
        typeof state.completed !== 'boolean' ||
        (state.completed && (state.index !== stageCount || state.pending || state.approvalWaiting)) ||
        (state.stageInput !== null && !isInput(state.stageInput)) ||
        !Array.isArray(state.inputQueue) ||
        !state.inputQueue.every(isInput) ||
        (state.explanation !== null && typeof state.explanation !== 'string') ||
        (state.approvalCall !== null &&
          (!object(state.approvalCall) ||
            typeof state.approvalCall.invocationId !== 'string' ||
            !state.approvalCall.invocationId ||
            typeof state.approvalCall.name !== 'string' ||
            !object(state.approvalCall.args))) ||
        (state.approvalWaiting && (!state.pending || !state.approvalCall)) ||
        typeof state.confirmed !== 'number' ||
        !Number.isSafeInteger(state.confirmed) ||
        state.confirmed < -1 ||
        state.confirmed >= stageCount ||
        typeof state.outputKey !== 'string' ||
        (state.outputKey !== '' && !/^[a-f0-9]{64}$/.test(state.outputKey)) ||
        state.stageCount !== stageCount
      )
        throw new Error('Invalid workflow checkpoint')
      const waiting = state.waiting
      if (
        waiting !== null &&
        (!object(waiting) ||
          typeof waiting.id !== 'string' ||
          !waiting.id ||
          !Array.isArray(waiting.questions) ||
          waiting.questions.length !== 1 ||
          !object(waiting.questions[0]) ||
          waiting.questions[0].id !== 'proceed' ||
          typeof waiting.questions[0].question !== 'string' ||
          JSON.stringify(waiting.questions[0].options) !== JSON.stringify(['Proceed', 'Cancel']) ||
          (waiting.input !== undefined && !isInput(waiting.input)) ||
          (options.confirm !== 'surface' &&
            (!object(waiting.handle) ||
              typeof waiting.handle.id !== 'string' ||
              typeof waiting.handle.sessionId !== 'string')) ||
          state.pending ||
          state.approvalWaiting)
      )
        throw new Error('Invalid pending workflow confirmation')
      options.validateSettings?.(state.settings)
      // Every scheduling field is checked above; business JSON stays opaque to the helper.
      return state as unknown as WorkflowCheckpointState
    },
  }
  return { initial, codec }
}
