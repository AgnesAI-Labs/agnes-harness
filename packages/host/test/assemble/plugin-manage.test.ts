import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolContext } from '@agnes/extension-api'
import type { PluginManageBridge } from '@agnes/host-extensions/resources/plugin-manage-port'
import { expect, it, vi } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

it('does not register an intrinsic plugin tool without an installed plugin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-plugin-tool-'))
  const bridge = vi.fn(async () => ({ host: 'Agnes Harness', items: [] }))
  const h = await createTestHost({ dataDir: dir, pluginManage: bridge })
  try {
    expect(h.host.kernel.tools.list().map((t) => t.name)).not.toContain('plugin_helper_install')
    expect(h.host.extensionRows.current().map((r) => r.id)).not.toContain('ext:plugin-helper/main')
  } finally {
    await h.host.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('binds builtin authoring to the real package, pinned generation, row and invocation lease', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-builtin-author-'))
  const candidateId = `candidate-${'a'.repeat(32)}`
  const candidateHash = `sha256-${'b'.repeat(64)}`
  const bridge = vi.fn<PluginManageBridge>(async () => ({
    candidateId,
    candidateHash,
    state: 'draft',
    packageId: 'test-plugin',
    baseHash: null,
    reviewHash: null,
    tests: null,
    message: 'Draft saved',
    sourceFiles: [],
  }))
  const h = await createTestHost({
    dataDir: dir,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
    pluginManage: bridge,
    disableSessionTitle: true,
    approval: async () => ({
      verdict: 'allowed-once',
      answeredBy: { id: 'reviewer', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    }),
    script: [
      [
        {
          type: 'toolcall_end',
          via: 'native',
          call: { toolUseId: '', name: 'tool_describe', args: { name: 'plugin_scaffold' }, ordinal: 0 },
        },
        { type: 'done', reason: 'toolUse' },
      ],
      [
        {
          type: 'toolcall_end',
          via: 'native',
          call: {
            toolUseId: '',
            name: 'plugin_scaffold',
            args: { template: 'skill', name: 'example' },
            ordinal: 0,
          },
        },
        { type: 'done', reason: 'toolUse' },
      ],
      [
        { type: 'text_delta', delta: 'drafted' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  try {
    const session = await h.host.createSession({ cwd: dir, key: 'author' })
    expect(
      session
        .currentTools()
        .list()
        .map((tool) => tool.name),
    ).toContain('plugin_scaffold')
    await session.enqueue('next-turn', { actor: session.d.actor, content: [{ type: 'text', text: 'draft' }] })
    const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(outcome, JSON.stringify(await session.scan({ toSeq: session.lastSeq }))).toMatchObject({
      reason: 'completed',
    })
    expect(
      bridge.mock.calls,
      JSON.stringify(await session.scan({ type: 'tool/result', toSeq: session.lastSeq })),
    ).toHaveLength(1)
    const first = bridge.mock.calls[0]
    if (!first) throw new Error('Missing authoring invocation')
    const [invocation, signal] = first
    expect(invocation).toMatchObject({
      packageId: '@agnes/base',
      snapshotId: h.host.sessionGeneration?.(session.key),
      rowId: 'ext:agnes/plugin-creator',
      sessionKey: session.key,
      input: { action: 'candidate.create' },
      turn: 1,
    })
    expect(invocation.snapshotId).toBeTruthy()
    expect(invocation.leaseId).toMatch(/^[a-f0-9-]{36}$/)
    expect(invocation.toolUseId).toBeTruthy()
    expect(signal.aborted).toBe(true) // The call capability ended with the tool.
    expect(JSON.stringify(await session.scan({ type: 'tool/result', toSeq: session.lastSeq }))).toContain(
      candidateId,
    )

    const tool = session.currentTools().resolve('plugin_candidate_write')
    if (!tool) throw new Error('Missing builtin candidate tool')
    const context = {
      signal: new AbortController().signal,
      session: {
        key: session.key,
        lane: session.lane,
        workspaceRoot: dir,
        toolUseId: 'refused',
        depth: 0,
        generationDepth: 1,
      },
      net: {},
      tools: {},
      artifacts: {},
      subagent: {},
    } as unknown as ToolContext
    const args = { candidateId, expectedHash: candidateHash, files: [{ path: 'x.md', content: 'x' }] }
    expect(await tool.execute(args, context)).toMatchObject({
      isError: true,
      details: { kind: 'permission-denied', operation: 'candidate.write', candidateId },
    })
    await expect(tool.execute(args, { ...context, signal: AbortSignal.abort() })).rejects.toBeDefined()
    expect(bridge).toHaveBeenCalledOnce()
    const cancelled = new AbortController()
    bridge.mockImplementationOnce(async (_invocation, signal) => {
      cancelled.abort()
      signal.throwIfAborted()
      throw new Error('Cancelled request must not continue')
    })
    await expect(
      tool.execute(args, {
        ...context,
        signal: cancelled.signal,
        session: { ...context.session, generationDepth: 0 },
      }),
    ).rejects.toBeDefined()
    expect(bridge).toHaveBeenCalledTimes(2)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 101 * 365 * 24 * 3600_000)
    try {
      await expect(
        tool.execute(args, { ...context, session: { ...context.session, generationDepth: 0 } }),
      ).rejects.toThrow(/lease expired/)
    } finally {
      clock.mockRestore()
    }
    expect(bridge).toHaveBeenCalledTimes(2)
    expect(h.host.sessionGeneration?.(session.key)).toBe(invocation.snapshotId)
    await h.host.close()
    await expect(
      tool.execute(args, { ...context, session: { ...context.session, generationDepth: 0 } }),
    ).rejects.toThrow(/lease|closed|unavailable/)
    expect(bridge).toHaveBeenCalledTimes(2)
  } finally {
    await h.host.close()
    await rm(dir, { recursive: true, force: true })
  }
})
