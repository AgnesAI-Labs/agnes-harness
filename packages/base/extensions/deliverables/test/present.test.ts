import type { ToolDef } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import deliverables from '../src/index.js'

describe('deliverable surface', () => {
  it('persists file references and presents friendly actionable data, refusing missing files', async () => {
    const tools: ToolDef[] = [],
      events: unknown[] = []
    extensionFactoryOf(deliverables)({
      registerProjection: () => () => {},
      registerTool: (tool: ToolDef) => {
        tools.push(tool)
        return () => {}
      },
      events: {
        append: async (_name: string, data: unknown) => {
          events.push(data)
        },
      },
    } as unknown as ExtensionAPI)
    const tool = tools[0]!
    const base = fakeToolContext({
      files: { 'cities.html': '<h1>Cities</h1>' },
      invoke: async () => ({ content: [] }),
    })
    const ctx = {
      ...base,
      projections: {
        ...base.projections,
        readOwn: async <T>() => ({
          status: 'available' as const,
          value: { presented: {} } as T,
          name: 'presented',
          stateVersion: 1,
          asOfSeq: 0,
        }),
      },
    }
    const result = await tool.execute(
      { files: [{ path: 'cities.html', name: 'Cities.html', description: 'City comparison' }] },
      ctx,
    )
    expect(result.isError).not.toBe(true)
    expect(events).toHaveLength(1)
    expect(ctx.calls.invoke[0]?.args).toMatchObject({
      surface: {
        title: 'Deliverables',
        titleKey: 'ui.deliverables',
        components: [{ id: 'file-0', kind: 'artifact-file', dataKey: 'file-0' }],
        data: {
          'file-0': { name: 'Cities.html', description: 'City comparison', artifact: { mime: 'text/html' } },
        },
      },
    })
    const failure = await tool.execute({ files: [{ path: 'missing.txt' }] }, ctx)
    expect(failure.isError).toBe(true)
    expect(events).toHaveLength(1)
  })
})
