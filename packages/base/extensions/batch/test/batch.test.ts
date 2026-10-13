import { readFileSync } from 'node:fs'
import {
  checkToolDef,
  type ExtensionAPI,
  type HookContext,
  type ToolContext,
  type ToolDef,
} from '@agnes/extension-api'
import type { BatchRequest, BatchStatus } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { ecosystem } from '../../../src/ecosystem.js'
import type { SeamInitContext } from '../../../src/seam-init.js'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createBatchExtension } from '../src/index.js'
import { batchTools, describeStatus } from '../src/tools.js'

const status: BatchStatus = {
  batchId: 'b0123456789ab',
  status: 'completed',
  dir: 'images',
  outDir: 'agh-batch/b0123456789ab',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  counts: { total: 3, pending: 0, running: 0, done: 2, invalid: 0, failed: 1, skipped: 0, cancelled: 0 },
  spentCredits: 0.75,
  files: ['agh-batch/b0123456789ab/results.csv'],
  summary: '# Batch b0123456789ab',
}
const bridge = () => {
  const calls: BatchRequest[] = []
  return {
    calls,
    port: {
      request: async (input: BatchRequest) => {
        calls.push(input)
        return status
      },
    },
  }
}
const tool = (tools: ReturnType<typeof batchTools>, name: string) => {
  const found = tools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`missing ${name}`)
  return found
}
const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((b) => b.text ?? '').join('')

describe('batch tools', () => {
  it('starts a batch with the session identity and the spec in protocol spelling', async () => {
    const b = bridge()
    const ctx = fakeToolContext({ cwd: '/work/proj' })
    const result = await tool(batchTools(b.port), 'batch_start').execute(
      {
        dir: 'images',
        prompt: 'Count insects in {{name}}',
        schema: { type: 'object' },
        concurrency: 2,
        max_edge: 1024,
        budget_credits: 5,
      },
      ctx,
    )
    expect(b.calls).toEqual([
      {
        op: 'start',
        sessionKey: ctx.session.key,
        toolUseId: 'tu-1',
        cwd: '/work/proj',
        spec: {
          dir: 'images',
          prompt: 'Count insects in {{name}}',
          schema: { type: 'object' },
          concurrency: 2,
          maxEdge: 1024,
          budgetCredits: 5,
        },
      },
    ])
    expect(text(result)).toContain('Batch b0123456789ab: completed')
    expect(text(result)).toContain('untrusted')
  })

  it('asks for an exported status and cancels by id', async () => {
    const b = bridge()
    const ctx = fakeToolContext()
    await tool(batchTools(b.port), 'batch_status').execute({ batch_id: 'b0123456789ab' }, ctx)
    await tool(batchTools(b.port), 'batch_cancel').execute({ batch_id: 'b0123456789ab' }, ctx)
    expect(b.calls).toEqual([
      { op: 'status', sessionKey: ctx.session.key, batchId: 'b0123456789ab', export: true },
      { op: 'cancel', sessionKey: ctx.session.key, batchId: 'b0123456789ab' },
    ])
  })

  it('explains that batches need the daemon, and refuses subagents', async () => {
    const absent = await tool(batchTools(undefined), 'batch_status').execute(
      { batch_id: 'b0123456789ab' },
      fakeToolContext(),
    )
    expect([absent.isError, text(absent)]).toEqual([true, expect.stringContaining('AGH daemon')])
    const base = fakeToolContext()
    const child = { ...base, session: { ...base.session, depth: 1 } } as ToolContext
    const refused = await tool(batchTools(bridge().port), 'batch_status').execute(
      { batch_id: 'b0123456789ab' },
      child,
    )
    expect([refused.isError, text(refused)]).toEqual([true, expect.stringContaining('Subagents')])
  })

  it('reports a daemon refusal as a tool error', async () => {
    const port = { request: async () => Promise.reject(new Error('dir must stay inside the workspace')) }
    const result = await tool(batchTools(port), 'batch_start').execute(
      { dir: '../x', prompt: 'p' },
      fakeToolContext(),
    )
    expect([result.isError, text(result)]).toEqual([
      true,
      expect.stringContaining('dir must stay inside the workspace'),
    ])
  })

  it('never asks for approval, passes the registration check and matches the manifest', () => {
    const tools = batchTools(undefined)
    expect(tools.map((t) => checkToolDef(t, { prefix: 'batch_' }))).toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
    ])
    expect(tools.map((t) => t.meta.requiresApproval)).toEqual(['never', 'never', 'never'])
    const manifest = JSON.parse(
      readFileSync(new URL('../agnes.extension.json', import.meta.url), 'utf8'),
    ) as {
      capabilities: { tools: { names: string[] } }
    }
    expect(tools.map((t) => t.name)).toEqual(manifest.capabilities.tools.names)
  })

  it('describes progress in one block', () => {
    const { files: _files, summary: _summary, ...running } = status
    const block = describeStatus({ ...running, status: 'running' })
    expect(block).toContain('done 2, running 0, pending 0, invalid 0, failed 1, skipped 0, cancelled 0')
    expect(block).not.toContain('Summary')
  })
})

describe('item sessions may only read', () => {
  it('denies every tool but read inside a batch item session', async () => {
    let hook: ((payload: { name: string }, ctx: HookContext) => unknown) | undefined
    const events: string[] = []
    const api = {
      registerTool: () => () => undefined,
      registerHook: (event: string, handler: typeof hook) => {
        events.push(event)
        hook = handler
        return () => undefined
      },
    } as unknown as ExtensionAPI
    await createBatchExtension(undefined)(api)
    expect(events).toEqual(['tool_call'])
    const at = (key: string) => ({ session: { key } }) as unknown as HookContext
    const item = 'agnes:local:default:batch:b0123456789ab:3'
    expect(await hook?.({ name: 'write' }, at(item))).toEqual({
      allow: false,
      reason: 'A batch item may only use the read tool.',
    })
    expect(await hook?.({ name: 'shell' }, at(item))).toMatchObject({ allow: false })
    // An item cannot start or steer a batch of its own.
    for (const name of ['batch_start', 'batch_status', 'batch_cancel'])
      expect(await hook?.({ name }, at(item)), name).toEqual({
        allow: false,
        reason: 'A batch item may only use the read tool.',
      })
    expect(await hook?.({ name: 'read' }, at(item))).toEqual({ allow: true })
    expect(await hook?.({ name: 'write' }, at('agnes:local:default:cli:workspace:0123456789abcdef'))).toEqual(
      {
        allow: true,
      },
    )
  })
})

describe('the bundled factory', () => {
  it('hands the daemon bridge from the init context to the tools', async () => {
    const b = bridge()
    const tools: ToolDef[] = []
    const api = {
      registerTool: (def: ToolDef) => {
        tools.push(def)
        return () => undefined
      },
      registerHook: () => () => undefined,
    } as unknown as ExtensionAPI
    await ecosystem['agnes/batch']({ batch: b.port } as unknown as SeamInitContext)(api)
    const ctx = fakeToolContext()
    const result = await tool(tools, 'batch_cancel').execute({ batch_id: 'b0123456789ab' }, ctx)
    expect([result.isError, b.calls]).toEqual([
      undefined,
      [{ op: 'cancel', sessionKey: ctx.session.key, batchId: 'b0123456789ab' }],
    ])
  })
})
