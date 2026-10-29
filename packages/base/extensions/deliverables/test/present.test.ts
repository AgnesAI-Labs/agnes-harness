import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDef } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import { fileMemoryProvider } from '@agnes/memory-file'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import deliverables from '../src/index.js'

describe('deliverable surface', () => {
  it.each(
    ['html', 'md', 'tgz'].flatMap((format) =>
      ['available', 'disabled', 'rejected', 'unavailable'].map((ui) => ({ format, ui })),
    ),
  )(
    'persists $format snapshots through memory protection with UI $ui, refusing missing files',
    async ({ format, ui }) => {
      const home = await mkdtemp(join(tmpdir(), 'agh-present-memory-'))
      try {
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
          cwd: process.cwd().replaceAll('\\', '/'),
          files: { [`cities.${format}`]: '<h1>城市</h1>' },
          invoke: async () => {
            if (ui === 'unavailable') throw new Error('Tool not found')
            return { content: [], isError: ui === 'rejected' }
          },
        })
        const ctx = {
          ...base,
          tools: { ...base.tools, list: () => (ui === 'disabled' ? [] : [{ ...tool, name: 'ui_render' }]) },
          fs: fileMemoryProvider
            .open({ home, workspaceRoot: base.cwd, sessionKey: base.session.key })
            .files(
              base.fs,
              { sessionKey: base.session.key, turn: 1 },
              new AbortController().signal,
              async () => {
                throw new Error('unexpected memory approval')
              },
            ),
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
          { files: [{ path: `cities.${format}`, name: `Cities.${format}`, description: 'City comparison' }] },
          ctx,
        )
        expect(result.isError).not.toBe(true)
        expect(events).toHaveLength(1)
        expect(result.structured).toMatchObject({
          deliverables: [
            {
              name: `Cities.${format}`,
              ref: { mime: { html: 'text/html', md: 'text/markdown', tgz: 'application/gzip' }[format] },
            },
          ],
          laneId: 'main',
        })
        if (ui === 'disabled') expect(ctx.calls.invoke).toEqual([])
        else
          expect(ctx.calls.invoke[0]?.args).toMatchObject({
            surface: {
              title: 'Deliverables',
              titleKey: 'ui.deliverables',
              components: [{ id: 'file-0', kind: 'artifact-file', dataKey: 'file-0' }],
              data: {
                'file-0': {
                  name: `Cities.${format}`,
                  description: 'City comparison',
                  artifact: {
                    mime: { html: 'text/html', md: 'text/markdown', tgz: 'application/gzip' }[format],
                    size: new TextEncoder().encode('<h1>城市</h1>').byteLength,
                  },
                },
              },
            },
          })
        const uriFailure = await tool.execute(
          { files: [{ path: 'artifact://synthetic/existing' }] },
          {
            ...ctx,
            fs: {
              ...ctx.fs,
              stat: async () => {
                throw new Error('URI must not reach filesystem')
              },
            },
          },
        )
        expect(uriFailure.isError).toBe(true)
        expect(uriFailure.content).toEqual([
          expect.objectContaining({
            text: expect.stringContaining('workspace filesystem path, not an artifact://'),
          }),
        ])
        expect(uriFailure.content).toEqual([
          expect.objectContaining({ text: expect.stringContaining('agh plugins pack') }),
        ])
        const failure = await tool.execute(
          { files: [{ path: `cities.${format}` }, { path: 'missing.txt' }] },
          ctx,
        )
        expect(failure.isError).toBe(true)
        expect(events).toHaveLength(1)
        expect(ctx.calls.invoke).toHaveLength(ui === 'disabled' ? 0 : 1)
        expect(ctx.calls.artifacts).toHaveLength(1)
        await base.fs.write(`cities.${format}`, 'changed after presentation')
        expect(new TextDecoder().decode(ctx.calls.artifacts[0]!.bytes)).toBe('<h1>城市</h1>')
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    },
  )
})
