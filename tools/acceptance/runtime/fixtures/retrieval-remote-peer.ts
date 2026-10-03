import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { LoopReadPorts } from '../../../../packages/extension-api/src/runtime/index.js'
import {
  memoryContext,
  memoryData,
} from '../../../../packages/extension-api/testkit/runtime/contracts/memory.js'
import type { RemoteRetrievalFixture } from '../../../../packages/extension-api/testkit/runtime/contracts/retrieval.js'
import type * as W from '../../../../packages/protocol/src/runtime/index.js'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '../../../../packages/protocol/src/runtime/index.js'

export const remotePeerBinding: W.BindingRef = {
  bindingId: 'fixture-remote-leaf',
  contract: 'agh.retrieval',
  logicalName: 'remote',
  providerId: 'fixture/http-retrieval',
}
export const remoteStateBinding: W.BindingRef = {
  bindingId: 'fixture-state',
  contract: 'agh.state',
  logicalName: 'state',
  providerId: 'fixture/published-state',
}
export const remoteTarget: W.ResourceRef = {
  resourceId: 'fixture-source',
  version: '1',
  digest: canonicalJsonDigest('source'),
}
const error: W.RuntimeError = {
  code: 'denied',
  detailCode: 'fixture_method_denied',
  message: 'Fixture only supplies published result queries',
  diagnosticId: 'remote-fixture',
  retryAdvice: { kind: 'never' },
}
export function remotePeerPorts(directory: string): LoopReadPorts {
  return {
    prepare(spec) {
      const prepared = validateRuntime('PreparedAction', {
        ...spec,
        intentFingerprint: canonicalJsonDigest(spec),
      })
      return prepared.ok ? { ok: true, value: prepared.value } : { ok: false, error }
    },
    async query(request) {
      if (
        request.method !== 'probeActionResult' ||
        request.target.bindingId !== remoteStateBinding.bindingId ||
        request.input.kind !== 'inline'
      )
        return { ok: false, error }
      const input = validateRuntime('ProbeActionResultRequest', request.input.value)
      if (!input.ok) return { ok: false, error }
      const view = JSON.parse(
        readFileSync(join(directory, 'published-result.json'), 'utf8'),
      ) as W.ActionVisibilityValue
      const value =
        view.actionId === input.value.actionId && view.sourceReceiptId === input.value.sourceReceiptId
          ? view
          : null
      return {
        ok: true,
        value: {
          kind: 'value',
          snapshot: 'published',
          output: memoryData(RuntimeMethodSchemaRefs['agh.state'].probeActionResult.output, value),
        },
      }
    },
    async compute() {
      return { ok: false, error }
    },
    async resolveData(data) {
      return data.kind === 'inline' ? { ok: true, value: data.value } : { ok: false, error }
    },
  }
}
/** Real HTTP transport, outside the composite; fixture State publishes the resulting receipt. */
export async function createRemotePeer(directory: string): Promise<RemoteRetrievalFixture> {
  let received = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const input = validateRuntime(
      'RetrievalSearchRemoteRequest',
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    )
    if (!input.ok) {
      response.writeHead(400)
      response.end()
      return
    }
    received++
    const provenance: W.Provenance = {
      producer: remotePeerBinding,
      sourceRefs: ['fixture-source'],
      trustLabels: ['derived'],
    }
    const result: W.RetrievalSearchRemoteResult = {
      hits: [
        { ref: { kind: 'resource', value: remoteTarget }, score: 1, source: provenance, trust: 'derived' },
      ],
      usageRefs: [],
      provenance,
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(result))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('remote peer address missing')
  return {
    remote: {
      state: remoteStateBinding,
      select: (target) =>
        canonicalJsonDigest(target) === canonicalJsonDigest(remoteTarget) ? remotePeerBinding : null,
    },
    target: remoteTarget,
    ports: remotePeerPorts(directory),
    requests: () => received,
    async dispatch(child) {
      if (
        child.target.bindingId !== remotePeerBinding.bindingId ||
        child.method !== 'searchRemote' ||
        child.input.kind !== 'inline'
      )
        throw new Error('remote child mismatch')
      const response = await fetch(`http://127.0.0.1:${address.port}/search`, {
        method: 'POST',
        body: JSON.stringify(child.input.value),
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error('remote peer failure')
      const output = validateRuntime('RetrievalSearchRemoteResult', await response.json())
      if (!output.ok) throw new Error('remote peer output invalid')
      const receipt: W.ActionResultView = {
        actionId: 'remote-child',
        receiptId: 'remote-receipt',
        sourceReceiptId: 'remote-receipt',
        attemptId: 'remote-attempt',
        bindingId: child.target.bindingId,
        inputDigest: child.input.kind === 'inline' ? child.input.digest : '',
        outcome: 'succeeded',
        result: memoryData(RuntimeMethodSchemaRefs['agh.retrieval'].searchRemote.output, output.value),
        externalRequests: [],
        usageRefs: [],
        references: [],
        provenance: output.value.provenance,
        completedAt: new Date().toISOString(),
        visibility: 'ready',
        viewId: 'remote-view',
        hookResultSetRef: null,
      }
      const view: W.ActionVisibilityValue = {
        actionId: receipt.actionId,
        sourceReceiptId: receipt.sourceReceiptId,
        revision: 1,
        state: 'ready',
        stageActionId: null,
        registrationDigest: null,
        result: receipt,
        uiResult: null,
        publishedByCommitId: 'fixture-publish',
      }
      if (!validateRuntime('ActionVisibilityValue', view).ok)
        throw new Error('published fixture result invalid')
      writeFileSync(join(directory, 'published-result.json'), JSON.stringify(view), { mode: 0o600 })
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
export const remoteHandlerScope = (binding: W.BindingRef, signal: AbortSignal = memoryContext().signal) => ({
  instanceId: 'fixture-instance',
  actionId: 'remote-parent',
  runId: 'fixture-run',
  bindingId: binding.bindingId,
  scope: memoryContext().scope,
  signal,
})
