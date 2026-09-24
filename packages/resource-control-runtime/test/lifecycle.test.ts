import { describe, expect, it, vi } from 'vitest'
import { createMcpResourceManager, validateManagedHttpUrl } from '../src/mcp.js'
import { notifyLiveSessionWorkers } from '../src/notify.js'
import { createSkillCandidateRegistry } from '../src/skills.js'

const barrier = { quiesce: async <T>(_id: string, publish: (permit: unknown) => Promise<T>) => publish({}) }
const definition = {
  serverId: 'example',
  displayName: 'Example',
  transport: { kind: 'stdio' as const, executable: 'example', args: [] },
  secretBinding: { kind: 'none' as const },
}

describe('resource runtime lifecycle boundaries', () => {
  it('keeps a successful Skill body as LKG input when the next root scan fails', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const candidate = {
      resourceId: `skill/user/user-agnes/${'a'.repeat(64)}`,
      name: 'review',
      description: 'Review',
      revision: 'b'.repeat(64),
      capabilityHash: 'c'.repeat(64),
      sourceIdentity: { scope: 'user' as const, rootKey: 'user-agnes' as const, sourceId: 'd'.repeat(64) },
      priority: 400,
      body: 'durable private body',
    }
    registry.replaceRoot('user-agnes', [candidate])
    registry.setControl({
      desired: [{ resourceId: candidate.resourceId, state: 'enabled' }],
      trust: [
        {
          resourceId: candidate.resourceId,
          revision: candidate.revision,
          capabilityHash: candidate.capabilityHash,
          state: 'trusted',
        },
      ],
    })
    await registry.activate('first', async () => undefined)
    registry.failRoot('user-agnes', new Error('scan failed'))
    await registry.activate('failed-rescan', async () => undefined)
    expect(registry.read(candidate.resourceId, { sessionKey: 'new-session' })).toEqual(
      expect.objectContaining({
        ok: true,
        content: candidate.body,
      }),
    )
    expect(registry.actual()[0]).toMatchObject({ stale: true, actual: 'ready' })
    expect(
      registry.snapshot().readFile(candidate.resourceId, candidate.revision, 'references/guide.md', {
        sessionKey: 'new-session',
      }),
    ).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('refuses skill file reads for untrusted, shadowed, and illegal paths', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const bytes = new TextEncoder().encode('# guide')
    const candidate = {
      resourceId: `skill/user/user-agnes/${'a'.repeat(64)}`,
      name: 'review',
      description: 'Review',
      revision: 'b'.repeat(64),
      capabilityHash: 'c'.repeat(64),
      sourceIdentity: { scope: 'user' as const, rootKey: 'user-agnes' as const, sourceId: 'd'.repeat(64) },
      priority: 400,
      body: 'durable private body',
      files: [
        {
          relativePath: 'references/guide.md',
          sha256: 'e'.repeat(64),
          kind: 'text' as const,
          mime: 'text/markdown',
          bytes,
        },
      ],
    }
    registry.replaceRoot('user-agnes', [candidate])
    registry.setControl({ desired: [], trust: [] })
    await registry.activate('disabled', async () => undefined)
    expect(
      registry
        .snapshot()
        .readFile(candidate.resourceId, candidate.revision, 'references/guide.md', { sessionKey: 's' }),
    ).toEqual({ ok: false, code: 'DISABLED' })
    registry.setControl({
      desired: [{ resourceId: candidate.resourceId, state: 'enabled' }],
      trust: [],
    })
    await registry.activate('untrusted', async () => undefined)
    expect(
      registry
        .snapshot()
        .readFile(candidate.resourceId, candidate.revision, 'references/guide.md', { sessionKey: 's' }),
    ).toEqual({ ok: false, code: 'UNTRUSTED_REVISION' })
    registry.setControl({
      desired: [{ resourceId: candidate.resourceId, state: 'enabled' }],
      trust: [
        {
          resourceId: candidate.resourceId,
          revision: candidate.revision,
          capabilityHash: candidate.capabilityHash,
          state: 'trusted',
        },
      ],
    })
    await registry.activate('trusted', async () => undefined)
    expect(
      registry
        .snapshot()
        .readFile(candidate.resourceId, 'f'.repeat(64), 'references/guide.md', { sessionKey: 's' }),
    ).toEqual({ ok: false, code: 'UNTRUSTED_REVISION' })
    expect(
      registry
        .snapshot()
        .readFile(candidate.resourceId, candidate.revision, 'references/guide.md', { sessionKey: 's' }),
    ).toEqual({ ok: true, content: '# guide', mime: 'text/markdown' })
    expect(
      registry
        .snapshot()
        .readFile(candidate.resourceId, candidate.revision, '../secret', { sessionKey: 's' }),
    ).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('projects an unexpected transport close once and fences a retired generation from a newer ready one', async () => {
    const listeners: Array<() => void> = []
    const applied = vi.fn(async () => undefined)
    const reports: unknown[] = []
    const connect = vi.fn(async () => {
      let listener: (() => void) | undefined
      listeners.push(() => listener?.())
      return {
        id: 'example',
        listTools: async () => [
          {
            name: 'read',
            description: 'Read',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
        callTool: async () => ({ content: [] }),
        close: async () => undefined,
        onClose(next: () => void) {
          listener = next
          return () => {
            listener = undefined
          }
        },
      }
    })
    const manager = createMcpResourceManager({
      barrier,
      profile: 'local-dev',
      credentials: async () => '',
      stdioPolicy: { allowedExecutables: ['example'] },
      connect,
      inspectCatalog: async (connection) => connection.listTools(),
      apply: applied,
      onStatus: (status) => reports.push(status),
    })
    manager.stage({ definition, revision: 'e'.repeat(64), desired: 'enabled', trust: 'trusted' })
    await manager.reconcile({
      profile: 'local-dev',
      serverId: 'example',
      definition,
      enabled: true,
      signal: new AbortController().signal,
    })
    listeners[0]?.()
    await vi.waitFor(() =>
      expect(manager.status('example')).toMatchObject({
        connectionState: 'unavailable',
        lastSafeError: { code: 'MCP_CONNECTION_LOST' },
      }),
    )
    expect(manager.tools('example')).toBeUndefined()
    await manager.reconnect({
      profile: 'local-dev',
      serverId: 'example',
      definition,
      signal: new AbortController().signal,
    })
    expect(manager.status('example')).toMatchObject({ connectionState: 'ready' })
    listeners[0]?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(manager.status('example')).toMatchObject({ connectionState: 'ready' })
    expect(reports.at(-1)).toMatchObject({ connectionState: 'ready' })
    expect(applied).toHaveBeenCalledTimes(3)
  })

  it('publishes an MCP generation but keeps a test connection short-lived', async () => {
    const closes: ReturnType<typeof vi.fn>[] = []
    const remoteSchema = {
      type: 'object',
      title: 'Fetch',
      description: 'Parameters for fetching a URL.',
      properties: {
        url: { type: 'string', format: 'uri', minLength: 1, title: 'Url' },
        max_length: { type: 'integer', default: 5000, exclusiveMinimum: 0 },
      },
      required: ['url'],
    }
    const emptyObjectSchema = { type: 'object' }
    const connect = vi.fn(async () => {
      const close = vi.fn(async () => undefined)
      closes.push(close)
      return {
        id: 'example',
        listTools: async () => [
          {
            name: 'empty',
            description: 'Empty object input',
            inputSchema: emptyObjectSchema,
          },
          {
            name: 'read',
            description: 'Read',
            inputSchema: remoteSchema,
          },
        ],
        callTool: async () => ({ content: [] }),
        close,
      }
    })
    const manager = createMcpResourceManager({
      barrier,
      profile: 'local-dev',
      credentials: async () => '',
      stdioPolicy: { allowedExecutables: ['example'] },
      connect,
      inspectCatalog: async (connection) => connection.listTools(),
      apply: async () => undefined,
    })
    manager.stage({ definition, revision: 'e'.repeat(64), desired: 'enabled', trust: 'trusted' })
    await expect(
      manager.reconcile({
        profile: 'local-dev',
        serverId: 'example',
        definition,
        enabled: true,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: { connectionState: 'ready' } })
    const tested = await manager.test({
      profile: 'local-dev',
      serverId: 'example',
      definition,
      signal: new AbortController().signal,
    })
    expect(tested).toMatchObject({ toolCount: 2 })
    expect(manager.tools('example')).toMatchObject({
      items: [
        { name: 'empty', inputSchema: emptyObjectSchema },
        { name: 'read', inputSchema: remoteSchema },
      ],
    })
    expect(connect).toHaveBeenCalledTimes(2)
    expect(closes[0]).not.toHaveBeenCalled()
    expect(closes[1]).toHaveBeenCalledTimes(1)
  })

  it('notifies live session workers (not the resource-lifecycle worker itself) after enabling an MCP server', async () => {
    const notified: string[] = []
    const fakePool = {
      activationLinks: () => [
        {
          sessionKey: 's1',
          generation: 1,
          link: {
            command: async (method: string) => {
              notified.push(method)
              return {}
            },
          },
        },
      ],
    }
    const connect = vi.fn(async () => ({
      id: 'example',
      listTools: async () => [
        {
          name: 'read',
          description: 'Read',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
      callTool: async () => ({ content: [] }),
      close: async () => undefined,
    }))
    const manager = createMcpResourceManager({
      barrier,
      profile: 'local-dev',
      credentials: async () => '',
      stdioPolicy: { allowedExecutables: ['example'] },
      connect,
      inspectCatalog: async (connection) => connection.listTools(),
      // The real production implementation (packages/resource-control-runtime/src/notify.ts), not a
      // mock: this proves notifyLiveSessionWorkers() genuinely drives a real reconcile()/applyActive()
      // through to the pool, not just that some callback fired. `McpApply` wants Promise<void>, so the
      // failed-keys list this task 7 added to notifyLiveSessionWorkers() is deliberately discarded here.
      apply: async () => {
        await notifyLiveSessionWorkers(fakePool)
      },
    })
    manager.stage({ definition, revision: 'e'.repeat(64), desired: 'enabled', trust: 'trusted' })
    expect(notified).toEqual([]) // staging alone must not notify - only an actual apply (reconcile) does
    await manager.reconcile({
      profile: 'local-dev',
      serverId: 'example',
      definition,
      enabled: true,
      signal: new AbortController().signal,
    })
    expect(notified).toEqual(['resource.stale'])
  })
})

describe('validateManagedHttpUrl message wording', () => {
  // validateManagedHttpUrl is shared by both the 'http' and 'sse' transport.kind cases in
  // validateManagedTransport() (mcp.ts), so its rejection message must not name one specific
  // transport -- a user who picked SSE and hit this must not be told they picked "HTTP transport".
  it('rejects a non-HTTPS, non-loopback URL with transport-agnostic wording', () => {
    expect(() => validateManagedHttpUrl(new URL('http://remote.example/mcp'), undefined)).toThrow(
      'this MCP transport requires HTTPS, or a local daemon with explicit loopback policy',
    )
  })
})
