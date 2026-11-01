import { CoreError, type Seq } from '@agnes/core-common/types'
import type { ExecuteAttempt } from '@agnes/core-effects/effects/execute-permits'
import { buildToolContext, type FsOps, type ToolContextDeps } from '@agnes/core-effects/effects/tool-context'
import type { HostDispatchObservation } from '@agnes/core-effects/effects/tool-dispatch'
import type { ToolContext } from '@agnes/extension-api'
import { automaticPermissionDecision } from '@agnes/protocol'
import { readSessionAttachment } from '../../request/session-files.js'
import { readSessionImages } from '../../request/session-images.js'
import { imageInput, imageInputPolicy } from '../../request/tool-images.js'
import { modelVisibleTool } from '../../step/model-tools.js'
import type { SessionImpl } from '../../step/session.js'
import { approveMemoryFile } from './memory-approval.js'
import { reviewTimeout } from './review-budget.js'
import { reviewToolContext } from './review-tool-context.js'
import { toolAvailability } from './tool-availability.js'
import { toolCallLimits } from './tool-call-limits.js'
import { discloseTool } from './tool-disclosure.js'
import type { ExecOpts, PlannedCall } from './tools.js'

const unavailableFs = (): Promise<never> =>
  Promise.reject(
    new CoreError('E_WORKSPACE_CLOSED', 'filesystem is unavailable outside a workspace invocation'),
  )
const NO_WORKSPACE_FS: FsOps = Object.freeze({
  read: unavailableFs,
  write: unavailableFs,
  list: unavailableFs,
  stat: unavailableFs,
})

/** One workspace invocation per attempt; nested work retains the parent's signal and lease. */
export function toolInvoker(
  s: SessionImpl,
  call: PlannedCall,
  input: {
    effect: { effectId: string }
    startSeq: Seq
    o: ExecOpts
    signal: AbortSignal
    softTimeoutMs: number
    approvalProof?: NonNullable<ToolContext['approval']>
    invokeNested: ToolContextDeps['invoke']
    markAttachmentRead: () => void
  },
): (attempt: ExecuteAttempt) => Promise<HostDispatchObservation> {
  const { effect, startSeq, o, signal, softTimeoutMs, approvalProof, invokeNested, markAttachmentRead } =
    input
  const op = s.op()
  const t = s.turn
  const def = t?.snapshot.byName.get(call.name)
  if (!op || !t || !def) throw new CoreError('E_RELATION', 'tool invocation lost its frozen turn')
  const computerUseAllowed = s.computerUseAllowed()
  const context = (fsOps: FsOps, workspace?: ToolContextDeps['workspace']) =>
    reviewToolContext(
      s,
      buildToolContext(
        {
          sessionKey: s.key,
          lane: s.lane,
          turn: op.meta.turn,
          step: op.step,
          depth: o.depth,
          generationDepth: s.generationDepth,
          actor: s.d.actor,
          decisions: s.decisions.port({
            owner: def.source.source,
            sourcePackage: def.packageIdentity ?? def.source.packageIdentity ?? def.source.source,
            packageVersion: def.packageVersion ?? def.source.packageVersion ?? 'unversioned',
            operationId: call.toolUseId,
            alive: () => signal.throwIfAborted(),
          }),
          ...(approvalProof ? { approval: approvalProof } : {}),
          cwd: s.d.cwd,
          workspaceRoot: s.workspaceRoot,
          fullAccess: s.yolo || automaticPermissionDecision(s.permissionContext) !== undefined,
          runtime: s.d.runtime,
          preset: s.preset,
          children: s.d.children,
          fsOps,
          ...(s.d.memory && workspace
            ? {
                memory: {
                  session: s.d.memory,
                  approve: (proposal: import('@agnes/extension-api').MemoryProposal) =>
                    approveMemoryFile(s, proposal, { name: call.name, meta: def.meta }, op.step, signal),
                },
              }
            : {}),
          ...(workspace ? { workspace } : {}),
          netFetch: s.d.netFetch,
          ...(s.d.publicFetch ? { publicFetch: s.d.publicFetch } : {}),
          log: s.d.logger,
          invoke: invokeNested,
          discloseTool: (name, signal) => discloseTool(s, name, signal),
          toolAvailability: (name) => toolAvailability(s, name),
          listTools: () =>
            t.snapshot.defs.filter((definition) => modelVisibleTool(definition, computerUseAllowed)),
          appendPlan: (items) =>
            s.d.log
              .append([s.ev('plan.items', { items }, { register: 'plan.items' })])
              .then((r) => r.firstSeq),
          requestCompaction: (i) => {
            t.compactionRequested = i ?? null
          },
          ...(s.d.requestMedia ? { readImages: (input) => readSessionImages(s, input, signal) } : {}),
          imageInputPolicy: async () => imageInputPolicy(s),
          imageInput: (input) => imageInput(s, input, signal),
          readAttachment: (input) => {
            markAttachmentRead()
            return readSessionAttachment(s, input, signal)
          },
          progress: () => undefined,
          registerArtifact: async (artifact) => {
            await s.d.log.append([
              s.ev(
                'x/core/artifact.registered',
                { artifact },
                {
                  ignorable: true,
                  sourceEventSeqs: [call.argsSeq],
                },
              ),
            ])
          },
          artifactJobEvent: (job) =>
            s.d.log
              .append([
                s.ev('artifact/job', job, { register: 'artifact/job', sourceEventSeqs: [call.argsSeq] }),
              ])
              .then(() => undefined),
          // What the writer lease actually has left, not a constant: a tool budgeting its own work
          // against a number the kernel invented plans against a deadline that is not the real one.
          lease: { remainingMs: () => s.d.log.leaseRemainingMs() },
        },
        {
          toolUseId: call.toolUseId,
          name: call.name,
          signal: signal,
          ...toolCallLimits(s, t, softTimeoutMs),
          timeoutMs: reviewTimeout(s, toolCallLimits(s, t, softTimeoutMs).timeoutMs),
        },
      ),
    )
  const invoke = (ctx: ReturnType<typeof context>, attempt: ExecuteAttempt) =>
    s.executeTool(
      call.name,
      call.args,
      ctx,
      { effectId: effect.effectId, startSeq },
      () => def.execute(call.args as never, ctx),
      { executionDomain: call.executionDomain, attempt },
    )
  return (attempt: ExecuteAttempt): Promise<HostDispatchObservation> => {
    const workspaceInvocation = s.d.workspaceInvocation
    if (workspaceInvocation) {
      const handler = async (
        view: import('@agnes/core-effects/workspace/runtime').WorkspaceInvocationView,
      ) => {
        const confined = await view.ready(signal)
        const ctx = context(view.fs(), {
          sandbox: view.hookSandbox(),
          confine: (argv) => confined.confine(argv),
          checkpoint: view.checkpointContext(),
        })
        return invoke(ctx, attempt)
      }
      return s.d.workspacePublication
        ? s.d.workspacePublication.workspace(() => ({ port: workspaceInvocation, handler }))
        : workspaceInvocation.run(handler)
    }
    if (call.executionDomain === 'workspace')
      return Promise.reject(
        new CoreError('E_WORKSPACE_CLOSED', 'workspace tool execution needs an invocation port'),
      )
    return invoke(context(NO_WORKSPACE_FS), attempt)
  }
}
