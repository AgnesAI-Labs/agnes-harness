import type { CallContext, ProviderFactory, ServiceProvider } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createPureToolAuthorAdapter } from '../../../extension-api/src/runtime/tool-authoring.js'
import type { LoopContractFixture } from '../../../extension-api/testkit/runtime/contracts/loop.js'
import { createDefaultToolsFactory, type ToolsDeployment } from '../../src/runtime/providers/tools.js'
import { openToolsFixture, toolsRef, toolsValue } from './tools-fixture.js'

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error('Missing consumer fixture value')
  return value
}
function inline(ref: W.DataRef) {
  if (ref.kind !== 'inline') throw new Error('Restricted peer has no blob source')
  return ref.value
}
// Real Loop and C10 implementations, with explicitly synthetic admission and receipt peers.
// This exercises the consumer chain, not production State/identity or cold recovery.
describe.each(['default', 'reference'] as const)('Loop to C10 %s consumer', (kind) => {
  it.each(['normal', 'wrong-model-ref', 'revoked'] as const)(
    'uses invoke and preserves the causal model reference: %s',
    async (mode) => {
      const module = (await import(
        new URL('../../../../tools/acceptance/runtime/platform/loop-conformance.ts', import.meta.url).href
      )) as {
        openLoopFixture(): Promise<LoopContractFixture & { receipts: Map<string, W.ActionResultView> }>
      }
      const f = await module.openLoopFixture(),
        template = await openToolsFixture(kind)
      const loop = await f.factory.create(f.config, f.dependencies, f.factoryContext)
      let tools: ServiceProvider | undefined
      try {
        toolsValue(await loop.ready(f.context))
        const first = await loop.start(f.frame, f.ports)
        const modelAction = required(first.actions[0])
        const modelRequest = validateRuntime('ModelInferRequest', inline(modelAction.input))
        if (!modelRequest.ok) throw new Error('Original model request invalid')
        await f.accept(modelAction)
        const toolTransition = await loop.resume(f.nextFrame(first), f.ports)
        const action = required(toolTransition.actions[0])
        const parsed = validateRuntime('ToolCall', inline(action.input))
        if (!parsed.ok) throw new Error('Loop did not produce a ToolCall')
        const invocation = parsed.value,
          target = action.target,
          originalRef = modelRequest.value.preparedRef
        expect(invocation.modelContextRef).toEqual(originalRef)
        let current = true,
          executed = 0,
          verified = false
        const denied = {
          ok: false as const,
          error: {
            code: 'denied' as const,
            detailCode: 'consumer_source_denied',
            message: 'Synthetic source refused',
            diagnosticId: 'loop-tools-fixture',
            retryAdvice: { kind: 'never' as const },
          },
        }
        const scope = f.context.scope
        if (scope.kind !== 'run') throw new Error('Run peer required')
        const deployment: ToolsDeployment = {
          ...template.deployment,
          descriptor: {
            ...template.deployment.descriptor,
            providerId: target.providerId,
            logicalName: target.logicalName,
          },
          definition: invocation.definition,
          checkCurrent: async () => (current ? { ok: true, value: undefined } : denied),
          async verifyCall(call, frame, context) {
            verified = true
            if (
              frame.runId !== f.frame.runId ||
              frame.actionId !== 'action-tool' ||
              context.scope.kind !== 'action' ||
              context.scope.runId !== f.frame.runId ||
              canonicalJsonDigest(call) !== canonicalJsonDigest(invocation) ||
              canonicalJsonDigest(call.modelContextRef) !== canonicalJsonDigest(originalRef)
            )
              return denied
            await Promise.resolve()
            if (mode === 'revoked') current = false
            return current ? { ok: true, value: undefined } : denied
          },
          createExecutor(call) {
            executed++
            return createPureToolAuthorAdapter(template.author, {
              definition: invocation.definition,
              inputDigest: call.input.kind === 'inline' ? call.input.digest : call.input.blob.digest,
              provenance: {
                producer: target,
                sourceRefs: ['synthetic-loop-model-source'],
                trustLabels: ['derived'],
              },
            })
          },
        }
        const create =
          kind === 'default'
            ? createDefaultToolsFactory
            : (
                (await import(
                  new URL('../../../../examples/runtime-reference/src/providers/tools.ts', import.meta.url)
                    .href
                )) as {
                  createReferenceToolsFactory(deployment: ToolsDeployment): ProviderFactory<ServiceProvider>
                }
              ).createReferenceToolsFactory
        tools = await create(deployment).create(template.configuration, template.dependencies, {
          instanceId: 'consumer-tools',
          bindingId: target.bindingId,
          signal: f.context.signal,
          scope: {
            kind: 'workspace',
            installationId: scope.installationId,
            runtimeId: scope.runtimeId,
            workspaceId: scope.workspaceId,
          },
        })
        // This test peer issues an action context; product code must use the real identity owner.
        const call: CallContext = {
          ...f.context,
          bindingId: target.bindingId,
          invocationId: 'consumer-tool',
          scope: { ...scope, kind: 'action', actionId: 'action-tool' },
        }
        const { signal: _signal, ...wire } = call
        const toolCall = structuredClone(invocation)
        if (mode === 'wrong-model-ref')
          toolCall.modelContextRef = toolsRef(RuntimeSchemaRefs.PreparedModelRequest, {})
        const input = toolsRef(RuntimeMethodSchemaRefs['agh.tools'].invoke.input, toolCall)
        if (input.kind !== 'inline') throw new Error('Inline input required')
        const frame: W.ActionFrame = {
          ...template.frame,
          runId: f.frame.runId,
          actionId: 'action-tool',
          parentActionId: null,
          bindingId: target.bindingId,
          input,
          inputDigest: input.digest,
          invocationId: call.invocationId,
          context: wire,
          snapshot: f.frame.snapshot,
          observedAt: f.frame.observedAt,
          actionTimebox: f.frame.actionTimebox,
        }
        const leaf = await required(tools.actions?.invoke).create({
          instanceId: 'consumer-tools',
          actionId: frame.actionId,
          runId: frame.runId,
          bindingId: frame.bindingId,
          scope: call.scope,
          signal: call.signal,
        })
        if (leaf.kind !== 'leaf') throw new Error('Pure leaf required')
        try {
          const result = await leaf.execute(frame, { ...template.actionContext, call })
          expect(verified).toBe(true)
          if (mode !== 'normal') {
            expect(result).toMatchObject({
              outcome: 'failed',
              error: { detailCode: 'consumer_source_denied' },
            })
            expect(executed).toBe(0)
            return
          }
          expect(result.outcome, JSON.stringify(result)).toBe('succeeded')
          expect(executed).toBe(1)
          const raw = validateRuntime('ToolResult', inline(required(result.result)))
          if (!raw.ok) throw new Error('Invalid C10 result')
          const { details: _details, ...visible } = raw.value
          const receipt: W.ActionResultView = {
            receiptId: 'receipt-tool',
            sourceReceiptId: 'receipt-tool',
            viewId: 'view-tool',
            actionId: frame.actionId,
            attemptId: frame.attemptId,
            bindingId: target.bindingId,
            inputDigest: input.digest,
            outcome: 'succeeded',
            result: toolsRef(RuntimeSchemaRefs.ToolModelResult, visible),
            externalRequests: [],
            usageRefs: [],
            references: result.references,
            provenance: { producer: target, sourceRefs: [], trustLabels: [] },
            completedAt: f.frame.observedAt,
            visibility: 'ready',
            hookResultSetRef: null,
          }
          // Synthetic ready projection from the actual C10 result, never f.accept(tool).
          f.receipts.set('tool', receipt)
          const second = await loop.resume(f.nextFrame(toolTransition), f.ports)
          expect(second.actions.map((item) => item.key)).toEqual(['second-model'])
          await f.accept(required(second.actions[0]))
          expect((await loop.resume(f.nextFrame(second), f.ports)).next.kind).toBe('complete')
        } finally {
          await leaf.close('shutdown')
        }
      } finally {
        await tools?.close('shutdown')
        await loop.close('shutdown')
        await f.close()
        await template.close()
      }
    },
  )
})
