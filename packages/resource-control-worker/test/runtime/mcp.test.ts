import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mcpData } from '../../src/runtime/mcp-types.js'
import { error, fixture, item, must, remove, scratch, selected } from './mcp-fixture.js'

describe.each(['default', 'reference'] as const)('%s MCP boundary', (kind) => {
  it('selects the actual provider and refuses missing features before connecting', async () => {
    const root = scratch()
    const subject = await fixture(kind, 'stdio', root)
    try {
      await selected(subject.service)
      expect(error(await subject.service.connect(subject.request, subject.auth.call()))).toBe(
        'denied/mcp_closed',
      )
    } finally {
      await subject.close()
      remove(root)
    }
  })
  it('refuses malformed, stale, unauthenticated, foreign scope and cancelled requests with no process', async () => {
    const root = scratch()
    const subject = await fixture(kind, 'stdio', root)
    try {
      await expect(fixture(kind, 'stdio', root, undefined, { tenantId: 'other' })).rejects.toThrow(
        'MCP journal ownership mismatch',
      )
      await expect(fixture(kind, 'stdio', root, undefined, { ownerId: 'other' })).rejects.toThrow(
        'MCP journal ownership mismatch',
      )
      expect(error(await subject.service.connect({}, subject.auth.call()))).toBe('invalid_input/mcp_schema')
      expect(
        error(
          await subject.service.connect(
            { ...subject.request, serverRef: { ...subject.request.serverRef, version: 'stale' } },
            subject.auth.call(),
          ),
        ),
      ).toBe('denied/mcp_resource')
      expect(error(await subject.service.connect(subject.request, { ...subject.auth.call() }))).toBe(
        'denied/mcp_denied',
      )
      expect(
        error(
          await subject.service.connect(
            subject.request,
            subject.auth.call({
              scope: { kind: 'runtime', installationId: 'install', runtimeId: 'runtime' },
            }),
          ),
        ),
      ).toBe('denied/mcp_denied')
      const stop = new AbortController()
      stop.abort()
      expect(
        error(await subject.service.connect(subject.request, subject.auth.call({ signal: stop.signal }))),
      ).toBe('cancelled/mcp_cancelled')
      subject.auth.revoke()
      expect(error(await subject.service.connect(subject.request, subject.auth.call()))).toBe(
        'denied/mcp_denied',
      )
    } finally {
      await subject.close()
      remove(root)
    }
  })
  it('does not invent a DCR client identity or accept foreign refresh targets', async () => {
    const root = scratch()
    const subject = await fixture(kind, 'streamable-http', root, 12345)
    try {
      const prepared = await subject.service.prepareConnection(
        { request: subject.request, credentialRefresh: null },
        subject.action(),
      )
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      const renewal = {
        requestId: 'refresh',
        secretId: 'credential',
        expectedVersion: 'v1',
        audience: 'fixture-peer',
        accountRef: 'other',
        serverRef: 'server',
        purpose: 'mcp-oauth',
      }
      expect(
        error(
          await subject.service.prepareConnection(
            { request: prepared.value, credentialRefresh: renewal },
            subject.action(),
          ),
        ),
      ).toBe('denied/mcp_credential')
      const action = subject.action()
      expect(
        error(
          await subject.service.prepareConnection(
            { request: prepared.value, credentialRefresh: { ...renewal, accountRef: 'account' } },
            {
              ...action,
              effects: {
                ...action.effects,
                invoke: async () => ({ ok: true, value: mcpData(null, 'fixture/wrong-refresh@1') }),
              },
            },
          ),
        ),
      ).toBe('incompatible/mcp_refresh_schema')
      const noClient = await fixture(kind, 'streamable-http', root, 12345, {
        endpoints: subject.options.endpoints.map(({ staticClientId: _client, ...endpoint }) => endpoint),
      })
      try {
        expect(
          error(
            await noClient.service.prepareConnection(
              { request: prepared.value, credentialRefresh: { ...renewal, accountRef: 'account' } },
              noClient.action(),
            ),
          ),
        ).toBe('denied/mcp_needs_reconnect')
      } finally {
        await noClient.close()
      }
    } finally {
      await subject.close()
      remove(root)
    }
  })
})

it('prepares the same fixed input and emits the same refusal codes across providers', async () => {
  const roots = [scratch(), scratch()]
  const subjects = await Promise.all(
    (['default', 'reference'] as const).map((kind, index) => fixture(kind, 'stdio', item(roots, index))),
  )
  try {
    const input = { request: item(subjects, 0).request, credentialRefresh: null }
    const outputs = await Promise.all(
      subjects.map((subject) => subject.service.prepareConnection(input, subject.action())),
    )
    expect(must(item(outputs, 0))).toEqual(must(item(outputs, 1)))
    for (const input of [
      {},
      {
        ...item(subjects, 0).request,
        serverRef: { ...item(subjects, 0).request.serverRef, version: 'unknown' },
      },
    ]) {
      const results = await Promise.all(
        subjects.map((subject) => subject.service.connect(input, subject.auth.call())),
      )
      expect(error(item(results, 0))).toBe(error(item(results, 1)))
      expect(results.every((result) => !result.ok)).toBe(true)
    }
  } finally {
    await Promise.all(subjects.map((subject) => subject.close()))
    roots.forEach(remove)
  }
})

it('keeps the reference independent and below the source overlap limit', () => {
  const reference = readFileSync(
    new URL('../../../../examples/runtime-reference/src/providers/mcp.ts', import.meta.url),
    'utf8',
  )
  const product = readFileSync(new URL('../../src/runtime/providers/mcp.ts', import.meta.url), 'utf8')
  const lines = (text: string) =>
    new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    )
  const a = lines(reference),
    b = lines(product)
  const common = [...a].filter((line) => b.has(line)).length
  expect(common / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.5)
  for (const name of ['mcp.ts', 'mcp-support.ts', 'mcp-wire.ts']) {
    const text = readFileSync(
      new URL(`../../../../examples/runtime-reference/src/providers/${name}`, import.meta.url),
      'utf8',
    )
    expect(text).not.toMatch(/(?:from|import\()[^\n]*resource-control-worker/)
  }
})
