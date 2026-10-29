import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'

type Registered = {
  parameters: { properties: Record<string, { description?: string }> }
  execute(input: unknown, ctx: unknown): Promise<{ isError?: boolean; content: Array<{ text: string }> }>
}
async function mcpManageTool(): Promise<Registered> {
  const entry = fileURLToPath(new URL('../bundled-plugins/mcp-helper/index.mjs', import.meta.url))
  const { mcpHelper } = (await import(pathToFileURL(entry).href)) as {
    mcpHelper: { apply(ctx: { tools: { register(tool: Registered): void } }): void }
  }
  let registered: Registered | undefined
  mcpHelper.apply({
    tools: {
      register: (tool) => {
        registered = tool
      },
    },
  })
  if (!registered) throw new Error('mcp_manage was not registered')
  return registered
}

it('answers a call missing its required field with a definite error and sends nothing', async () => {
  const tool = await mcpManageTool()
  const request = vi.fn(async () => ({ state: 'prepared' }))
  const ctx = { mcpManage: { request } }
  for (const [input, field] of [
    [{ action: 'status' }, 'proposalId'],
    [{ action: 'commit' }, 'proposalId'],
    [{ action: 'cancel' }, 'proposalId'],
    [{ action: 'prepare' }, 'definition'],
  ] as const) {
    const result = await tool.execute(input, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain(`needs ${field}; nothing was sent`)
  }
  expect(request).not.toHaveBeenCalled()
  await tool.execute({ action: 'list' }, ctx)
  await tool.execute({ action: 'status', proposalId: 'mcp-onboard-x' }, ctx)
  expect(request).toHaveBeenCalledTimes(2)
  // The model reads which action needs what from the schema itself.
  expect(tool.parameters.properties.proposalId?.description).toContain('commit, status and cancel')
})
