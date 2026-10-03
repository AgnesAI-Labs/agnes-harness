import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  type McpPort,
  registerMcpContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/mcp.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import {
  error,
  fixture,
  httpPeer,
  invocation,
  type Kind,
  must,
  readSchema,
  remove,
  scratch,
  selected,
  state,
  type Transport,
} from '../../../../packages/resource-control-worker/test/runtime/mcp-fixture.js'
import { recoverMcp, until } from '../../../../packages/resource-control-worker/test/runtime/mcp-process.js'
import { getConformanceBuildIdentity } from '../build-identity.js'
import type { ConformanceBindRequest, ConformanceBindResult } from '../run-conformance.js'

function sourceDigest(kind: Kind): string {
  const files =
    kind === 'default'
      ? ['providers/mcp', 'mcp-types', 'mcp-leases', 'mcp-journal', 'mcp-transport']
      : ['mcp', 'mcp-support', 'mcp-wire']
  const root =
    kind === 'default'
      ? 'packages/resource-control-worker/src/runtime'
      : 'examples/runtime-reference/src/providers'
  const hash = createHash('sha256')
  for (const name of files)
    hash.update(readFileSync(new URL(`../../../../${root}/${name}.ts`, import.meta.url)))
  return hash.digest('hex')
}
function port(kind: Kind, transport: Transport): McpPort {
  const recipe = `mcp-${transport}`
  const providerDigest = sourceDigest(kind)
  const configDigest = canonicalJsonDigest({
    transport,
    credential: transport === 'stdio' ? null : 'managed-fixed-version',
    timeoutMs: 1500,
  })
  const releaseSetDigest = canonicalJsonDigest({ providerDigest, configDigest })
  const evidence = (detail: string) => ({
    passed: true,
    detail,
    providerDigest,
    configDigest,
    releaseSetDigest,
  })
  async function exercise(
    work: (
      subject: Awaited<ReturnType<typeof fixture>>,
      root: string,
      peer: Awaited<ReturnType<typeof httpPeer>> | undefined,
    ) => Promise<void>,
  ) {
    const root = scratch(),
      peer = transport === 'streamable-http' ? await httpPeer() : undefined
    let subject: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      subject = await fixture(kind, transport, root, peer?.port)
      await work(subject, root, peer)
    } finally {
      await subject?.close()
      await peer?.close()
      remove(root)
    }
  }
  return {
    recipe,
    features: ['connect', 'prepareConnection', 'call', 'read', transport, 'durable-request-identity'],
    async select() {
      await exercise(async (subject) => {
        await selected(subject.service, providerDigest)
      })
      return evidence('Published the actual provider and refused an unavailable transport feature')
    },
    async normal() {
      await exercise(async (subject, _root, peer) => {
        const first = await subject.connect(),
          input = invocation(first.result.connectionRef),
          context = subject.auth.call()
        const result = await subject.service.call(input, context)
        assert.equal(state(must(result)).value, 'hello')
        assert.equal(
          canonicalJsonDigest(await subject.service.call(input, context)),
          canonicalJsonDigest(result),
        )
        const value = { uri: 'fixture://resource' }
        const read = must(
          await subject.service.read(
            {
              connectionRef: first.result.connectionRef,
              method: 'resources/read',
              methodSchema: readSchema,
              params: {
                kind: 'inline',
                schema: readSchema,
                value,
                bytes: Buffer.byteLength(JSON.stringify(value)),
                digest: canonicalJsonDigest(value),
              },
            },
            subject.auth.call(),
          ),
        )
        assert.equal(read.contentRefs[0]?.kind, 'inline')
        if (read.contentRefs[0]?.kind === 'inline')
          assert.equal(
            canonicalJsonDigest(read.contentRefs[0].value),
            canonicalJsonDigest({ contents: [{ uri: value.uri, text: 'fixture-resource' }] }),
          )
        if (peer) {
          await peer.rotate()
          const failedContext = subject.auth.call(),
            failed = await subject.service.call(input, failedContext)
          assert.equal(error(failed), 'denied/credential_refresh_required')
          if (failed.ok) throw new Error('Expected an authentication refusal')
          const renewal = (failed.error.safeDetail as { request: unknown }).request
          const fixed = must(
            await subject.service.prepareConnection(
              { request: first.prepared, credentialRefresh: renewal },
              subject.action(),
            ),
          )
          assert.equal(first.prepared.credentialRef?.version, 'v1')
          assert.equal(fixed.credentialRef?.version, 'v2')
          const next = must(await subject.service.connect(fixed, subject.auth.call()))
          assert.equal(
            state(must(await subject.service.call(invocation(next.connectionRef), subject.auth.call())))
              .value,
            'hello',
          )
          assert.deepEqual(await subject.service.call(input, failedContext), failed)
        }
      })
      return evidence(
        'Executed real JSON-RPC and exact receipt replay; HTTP refreshed a fixed credential under a new action',
      )
    },
    async deny() {
      await exercise(async (subject) => {
        const { result } = await subject.connect(),
          request = invocation(result.connectionRef)
        assert.equal(
          error(
            await subject.service.call(
              { ...request, methodSchema: { ...request.methodSchema, revision: 2 } },
              subject.auth.call(),
            ),
          ),
          'invalid_input/mcp_method_schema',
        )
        subject.auth.tools(false)
        assert.equal(
          error(await subject.service.call(request, subject.auth.call())),
          'denied/mcp_tools_admission',
        )
        subject.auth.revoke()
        assert.equal(error(await subject.service.call(request, subject.auth.call())), 'denied/mcp_denied')
      })
      return evidence('Refused stale schemas, tool admission revocation and revoked identity')
    },
    async cancel() {
      await exercise(async (subject, root, peer) => {
        const { result } = await subject.connect(),
          cancel = new AbortController(),
          call = subject.auth.call({ signal: cancel.signal })
        const request = invocation(result.connectionRef, 'hang'),
          pending = subject.service.call(request, call)
        await until(async () =>
          peer
            ? (await peer.calls()).some((row) => row.name === 'hang')
            : readFileSync(`${root}/stdio-calls.ndjson`, 'utf8').includes('"name":"hang"'),
        )
        cancel.abort()
        assert.match(error(await pending), /^unknown_effect\//)
        assert.equal(error(await subject.service.call(request, call)), 'cancelled/mcp_cancelled')
      })
      return evidence('Cancelled an observed real business request and retained its uncertain effect')
    },
    async recover() {
      await recoverMcp(kind, transport)
      return evidence(
        'SIGKILLed the provider, reopened its journal in a fresh process, refused replay and executed a new call',
      )
    },
    async dispose() {
      await exercise(async (subject) => {
        const { result } = await subject.connect(),
          ref = result.connectionRef
        const before = state(must(await subject.service.call(invocation(ref), subject.auth.call())))
        must(await subject.service.retain(ref, 'retained-run', subject.auth.call()))
        await subject.service.close()
        assert.equal(
          error(await subject.service.call(invocation(ref), subject.auth.call())),
          'denied/mcp_closed',
        )
        if (transport === 'stdio') process.kill(before.pid, 0)
        must(await subject.service.release(ref, 'retained-run', subject.auth.call()))
        if (transport === 'stdio')
          await until(() => {
            try {
              process.kill(before.pid, 0)
              return false
            } catch {
              return true
            }
          })
        await subject.service.close()
      })
      return evidence(
        'Closed idempotently, refused new use, preserved a retained run and closed after its last release',
      )
    },
  }
}
export async function bindConformance(
  harness: ConformanceHarness,
  request: ConformanceBindRequest,
): Promise<ConformanceBindResult> {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.mcp'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter(
    (kind): kind is Kind => kind === 'default' || kind === 'reference',
  )
  for (const providerId of providers)
    registerMcpContract(harness, {
      providerId,
      command: request.command,
      build: getConformanceBuildIdentity(),
      sources: [port(providerId, 'stdio'), port(providerId, 'streamable-http')],
    })
  return { contracts: ['agh.mcp'], providers }
}
