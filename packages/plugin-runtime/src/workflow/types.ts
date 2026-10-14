import type {
  DecisionHandle,
  LoopCheckpoint,
  LoopContext,
  LoopInput,
  LoopToolCall,
  ToolDef,
  ToolPolicy,
  ToolResult,
} from '@agnes/extension-api'
export type JsonValue = LoopCheckpoint['state']

export type WorkflowData = Record<string, JsonValue>

/** Business evidence visible to stages. Scheduling and authorization remain platform-owned. */
export interface WorkflowState {
  readonly input: string
  readonly index: number
  readonly stageCount: number
  readonly outputKey: string
  readonly settings: WorkflowData
  readonly stageInput: LoopInput | null
  data: WorkflowData
}

export interface WorkflowStage {
  name: string
  confirm?(state: WorkflowState): string | undefined
  /** This stage invokes a tool that can require a backend approval. */
  approval?: boolean
  /** Receive a complete input at a safe step boundary, including generic system notifications. */
  inputStage?: boolean
  run(ctx: LoopContext, state: WorkflowState, signal: AbortSignal): Promise<WorkflowData>
  /** The transcript line for this stage's result. Without it the line is the stage name and its data as JSON. */
  message?(data: WorkflowData): string | undefined
}

export interface WorkflowOptions {
  id: string
  version: string
  /** The title shown in the plan and in published deliverables. Defaults to `id`. */
  name?: string
  stages: readonly WorkflowStage[]
  tools?: readonly ToolDef[]
  skills?: readonly { name: string; description: string; body: string }[]
  validateSettings?(settings: WorkflowData): WorkflowData
  /** DecisionPort is the default. Surface confirmation retains ask_user_question presentation. */
  confirm?: 'decision' | 'surface'
  /** Omission disables file publishing; all writes use official read/write/present ports. */
  deliverables?: {
    directory: string
    markdown?(state: WorkflowState): string | undefined
    html?(state: WorkflowState): string | undefined
  }
  readOnly?: boolean
  /** Optional business rule, layered after the shipped policy's denials and output restrictions. */
  policy?: ToolPolicy['decide']
  guardToolCall?(call: LoopToolCall, state: WorkflowState): void
  /** Return true when business evidence changed and must be checkpointed. */
  recordToolResult?(call: LoopToolCall, result: ToolResult, state: WorkflowState): boolean
}

export interface WorkflowCheckpointState extends WorkflowState {
  workflow: string
  index: number
  input: string
  outputKey: string
  stageInput: LoopInput | null
  inputQueue: LoopInput[]
  pending: boolean
  approvalWaiting: boolean
  approvalCall: (LoopToolCall & { invocationId: string }) | null
  explanation: string | null
  waiting: {
    id: string
    questions: { id: string; question: string; options: string[] }[]
    handle?: DecisionHandle
    input?: LoopInput
  } | null
  confirmed: number
  completed: boolean
}
