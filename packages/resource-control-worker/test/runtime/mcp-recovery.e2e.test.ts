import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMcpLeases } from '../../src/runtime/mcp-leases.js'
import { mcpData } from '../../src/runtime/mcp-types.js'
import {
  error,
  fixture,
  httpPeer,
  invocation,
  item,
  must,
  readSchema,
  remove,
  scan,
  scratch,
  state,
} from './mcp-fixture.js'
import { recoverMcp, until } from './mcp-process.js'

describe.each(['default', 'reference'] as const)('%s MCP real peers', (kind) => {
  it.each(['wrong-version', 'duplicate-catalog', 'no-resources'] as const)(
    'refuses a real peer with %s negotiation',
    async (mode) => {
      const root = scratch(),
        subject = await fixture(kind, 'stdio', root, undefined, {}, undefined, mode)
      try {
        if (mode !== 'no-resources') {
          expect(error(await subject.service.connect(subject.request, subject.auth.call()))).toBe(
            mode === 'wrong-version' ? 'incompatible/mcp_protocol_version' : 'incompatible/mcp_catalog',
          )
        } else {
          const { result } = await subject.connect()
          const params = mcpData({ uri: 'fixture://resource' }, readSchema.typeId)
          params.schema = readSchema
          expect(
            error(
              await subject.service.read(
                {
                  connectionRef: result.connectionRef,
                  method: 'resources/read',
                  methodSchema: readSchema,
                  params,
                },
                subject.auth.call(),
              ),
            ),
          ).toBe('invalid_input/mcp_method_schema')
          expect(readFileSync(`${root}/stdio-calls.ndjson`, 'utf8')).not.toContain(
            '"method":"resources/read"',
          )
        }
      } finally {
        await subject.close()
        remove(root)
      }
    },
  )
  it.each(['stdio', 'streamable-http'] as const)(
    '%s executes, reads, refuses stale schema and revoked access, and preserves cancellation uncertainty',
    async (transport) => {
      const root = scratch(),
        peer = transport === 'streamable-http' ? await httpPeer() : undefined
      const ambient = process.env.AGNES_MCP_TEST_AMBIENT
      process.env.AGNES_MCP_TEST_AMBIENT = 'fixture-only'
      const subject = await fixture(kind, transport, root, peer?.port)
      try {
        const { result } = await subject.connect()
        const input = invocation(result.connectionRef)
        const call = subject.auth.call()
        const first = must(await subject.service.call(input, call))
        expect(state(first).value).toBe('hello')
        if (transport === 'stdio') expect(state(first).environment).not.toContain('AGNES_MCP_TEST_AMBIENT')
        expect(await subject.service.call(input, call)).toEqual({ ok: true, value: first })
        expect(
          error(await subject.service.call(invocation(result.connectionRef, 'echo', 'changed'), call)),
        ).toBe('conflict/mcp_request_identity')
        expect(
          error(
            await subject.service.call(
              { ...input, methodSchema: { ...input.methodSchema, revision: 2 } },
              subject.auth.call(),
            ),
          ),
        ).toBe('invalid_input/mcp_method_schema')
        subject.auth.tools(false)
        expect(error(await subject.service.call(input, subject.auth.call()))).toBe(
          'denied/mcp_tools_admission',
        )
        subject.auth.tools(true)
        const params = mcpData({ uri: 'fixture://resource' }, readSchema.typeId)
        params.schema = readSchema
        const read = must(
          await subject.service.read(
            {
              connectionRef: result.connectionRef,
              method: 'resources/read',
              methodSchema: readSchema,
              params,
            },
            subject.auth.call(),
          ),
        )
        expect(read.contentRefs[0]?.kind).toBe('inline')
        const abort = new AbortController(),
          interrupted = subject.auth.call({ signal: abort.signal })
        const hang = subject.service.call(invocation(result.connectionRef, 'hang'), interrupted)
        await until(async () =>
          transport === 'stdio'
            ? readFileSync(`${root}/stdio-calls.ndjson`, 'utf8').includes('"name":"hang"')
            : ((await peer?.calls())?.some((row) => row.name === 'hang') ?? false),
        )
        abort.abort()
        expect(error(await hang)).toMatch(/^unknown_effect\//)
        expect(
          error(await subject.service.call(invocation(result.connectionRef, 'hang'), interrupted)),
        ).toMatch(/cancelled\/mcp_cancelled/)
        subject.auth.revoke()
        expect(error(await subject.service.call(input, subject.auth.call()))).toBe('denied/mcp_denied')
        scan(root, [first, read])
      } finally {
        if (ambient === undefined) delete process.env.AGNES_MCP_TEST_AMBIENT
        else process.env.AGNES_MCP_TEST_AMBIENT = ambient
        await subject.close()
        await peer?.close()
        remove(root)
      }
    },
  )
  it('retains the failed 401 receipt and connects with a refreshed exact version under a new action', async () => {
    const root = scratch(),
      peer = await httpPeer()
    const subject = await fixture(kind, 'streamable-http', root, peer.port)
    try {
      const { result, prepared } = await subject.connect()
      await peer.rotate()
      const oldCall = subject.auth.call(),
        request = invocation(result.connectionRef)
      const failed = await subject.service.call(request, oldCall)
      expect(error(failed)).toBe('denied/credential_refresh_required')
      if (failed.ok) throw new Error('Expected credential refusal')
      const detail = failed.error.safeDetail as { request: unknown }
      const next = must(
        await subject.service.prepareConnection(
          { request: prepared, credentialRefresh: detail.request },
          subject.action(),
        ),
      )
      expect(prepared.credentialRef?.version).toBe('v1')
      expect(next.credentialRef?.version).toBe('v2')
      const connected = must(await subject.service.connect(next, subject.auth.call()))
      expect(
        state(must(await subject.service.call(invocation(connected.connectionRef), subject.auth.call())))
          .value,
      ).toBe('hello')
      // Reading the original receipt never attempts to consume the invalidated old handle.
      expect(await subject.service.call(request, oldCall)).toEqual(failed)
      scan(root, [failed, next, connected])
    } finally {
      await subject.close()
      await peer.close()
      remove(root)
    }
  })
  it('rebuilds a killed stdio child without replaying its unknown business call', async () => {
    const root = scratch(),
      subject = await fixture(kind, 'stdio', root)
    try {
      const { result } = await subject.connect()
      const pid = state(
        must(await subject.service.call(invocation(result.connectionRef), subject.auth.call())),
      ).pid
      const call = subject.auth.call(),
        unknown = invocation(result.connectionRef, 'hang')
      const pending = subject.service.call(unknown, call)
      await until(() => readFileSync(`${root}/stdio-calls.ndjson`, 'utf8').includes('"name":"hang"'))
      process.kill(pid, 'SIGKILL')
      expect(error(await pending)).toMatch(/^unknown_effect\//)
      expect(error(await subject.service.call(unknown, call))).toMatch(/^unknown_effect\//)
      const rebuilt = state(
        must(await subject.service.call(invocation(result.connectionRef), subject.auth.call())),
      )
      expect(rebuilt.pid).not.toBe(pid)
      expect(
        readFileSync(`${root}/stdio-calls.ndjson`, 'utf8')
          .split('\n')
          .filter((row) => row.includes('"name":"hang"')),
      ).toHaveLength(1)
    } finally {
      await subject.close()
      remove(root)
    }
  })
  it.each(['stdio', 'streamable-http'] as const)(
    '%s cold recovery retains an unknown request after provider SIGKILL',
    async (transport) => {
      await recoverMcp(kind, transport)
    },
  )
})

it.each(['default', 'reference'] as const)(
  '%s preserves an old generation until its last owner exits',
  async (kind) => {
    const root = scratch(),
      leases = createMcpLeases()
    const old = await fixture(kind, 'stdio', root, undefined, {}, leases)
    const next = await fixture(
      kind,
      'stdio',
      root,
      undefined,
      { directory: `${root}/new-provider`, ownerId: 'generation-2' },
      leases,
    )
    try {
      const { result } = await old.connect(),
        ref = result.connectionRef
      const pid = state(must(await old.service.call(invocation(ref), old.auth.call()))).pid
      must(await old.service.retain(ref, 'old-run', old.auth.call()))
      must(await old.service.retain(ref, 'old-run', old.auth.call()))
      await next.connect()
      await next.close()
      expect(state(must(await old.service.call(invocation(ref), old.auth.call()))).pid).toBe(pid)
      must(await old.service.release(ref, 'generation-1', old.auth.call()))
      must(await old.service.release(ref, 'generation-1', old.auth.call()))
      if (kind === 'default') expect(leases.inspect(ref.id)?.owners).toEqual(['old-run'])
      await old.service.close()
      process.kill(pid, 0)
      old.auth.revoke()
      must(
        await old.service.release(
          ref,
          'old-run',
          old.auth.call({ signal: AbortSignal.abort(), deadline: '2000-01-01T00:00:00Z' }),
        ),
      )
      must(await old.service.release(ref, 'old-run', old.auth.call()))
      if (kind === 'default') expect(leases.inspect(ref.id)).toBeNull()
      await until(() => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      })
      expect(error(await old.service.call(invocation(ref), old.auth.call()))).toBe('denied/mcp_connection')
    } finally {
      await old.close()
      await next.close()
      remove(root)
    }
  },
)

it('returns the same remote resource and refusal across independent providers', async () => {
  const roots = [scratch(), scratch()]
  const subjects = await Promise.all(
    (['default', 'reference'] as const).map((kind, index) => fixture(kind, 'stdio', item(roots, index))),
  )
  try {
    const results = []
    for (const subject of subjects) {
      const { result } = await subject.connect()
      const params = mcpData({ uri: 'fixture://resource' }, readSchema.typeId)
      params.schema = readSchema
      const read = must(
        await subject.service.read(
          { connectionRef: result.connectionRef, method: 'resources/read', methodSchema: readSchema, params },
          subject.auth.call(),
        ),
      )
      results.push({
        contentRefs: read.contentRefs,
        remoteReceipt: read.remoteReceipt,
        sourceRefs: read.provenance.sourceRefs,
        trustLabels: read.provenance.trustLabels,
      })
      expect(
        error(await subject.service.call(invocation(result.connectionRef, 'unknown'), subject.auth.call())),
      ).toBe('invalid_input/mcp_tool')
      expect(readFileSync(`${subject.options.directory}/../stdio-calls.ndjson`, 'utf8')).not.toContain(
        '"name":"unknown"',
      )
    }
    expect(results[0]).toEqual(results[1])
  } finally {
    await Promise.all(subjects.map((subject) => subject.close()))
    roots.forEach(remove)
  }
})
