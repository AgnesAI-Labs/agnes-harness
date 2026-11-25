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
    [
      ...['html', 'md', 'tgz', 'svg'].map((format) => ({
        path: `cities.${format}`,
        name: `Cities.${format}`,
        expectedName: `Cities.${format}`,
        mime: {
          html: 'text/html',
          md: 'text/markdown',
          tgz: 'application/gzip',
          svg: 'image/svg+xml',
        }[format],
      })),
      ...[
        { name: '城市资料页', expectedName: '城市资料页.html' },
        { name: 'Cities.HTML', expectedName: 'Cities.HTML' },
        { name: 'Cities.v2', expectedName: 'Cities.v2.html' },
        { name: 'Cities.pdf', expectedName: 'Cities.pdf.html' },
        { name: undefined, expectedName: 'cities.html' },
        { name: '城'.repeat(256), expectedName: `${'城'.repeat(251)}.html` },
        { name: `${'城'.repeat(251)}.html`, expectedName: `${'城'.repeat(251)}.html` },
      ].map((row) => ({ ...row, path: 'cities.html', mime: 'text/html' })),
      { path: 'cities.HTML', name: '城市资料页', expectedName: '城市资料页.HTML', mime: 'text/html' },
      { path: 'cities', name: '城市资料', expectedName: '城市资料', mime: 'application/octet-stream' },
      { path: '.cities', name: '城市资料', expectedName: '城市资料', mime: 'application/octet-stream' },
      { path: 'cities.', name: '城市资料', expectedName: '城市资料', mime: 'application/octet-stream' },
      {
        path: 'cities.custom',
        name: '城市资料',
        expectedName: '城市资料.custom',
        mime: 'application/octet-stream',
      },
    ].flatMap((row) => ['available', 'disabled', 'rejected', 'unavailable'].map((ui) => ({ ...row, ui }))),
  )(
    'persists $path as $expectedName through memory protection with UI $ui, refusing missing files',
    async ({ path, name, expectedName, mime, ui }) => {
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
          files: { [path]: '<h1>城市</h1>' },
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
          { files: [{ path, ...(name === undefined ? {} : { name }), description: 'City comparison' }] },
          ctx,
        )
        expect(result.isError).not.toBe(true)
        expect(events).toHaveLength(1)
        expect(result.structured).toMatchObject({
          deliverables: [
            {
              name: expectedName,
              ref: { mime },
            },
          ],
          laneId: 'main',
        })
        expect(events[0]).toMatchObject({ files: [{ name: expectedName, ref: { mime } }] })
        expect(ctx.calls.artifacts[0]).toMatchObject({ name: expectedName, mime })
        if (ui === 'disabled') expect(ctx.calls.invoke).toEqual([])
        else
          expect(ctx.calls.invoke[0]?.args).toMatchObject({
            surface: {
              title: 'Deliverables',
              titleKey: 'ui.deliverables',
              components: [{ id: 'file-0', kind: 'artifact-file', dataKey: 'file-0' }],
              data: {
                'file-0': {
                  name: expectedName,
                  description: 'City comparison',
                  artifact: {
                    mime,
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
        const failure = await tool.execute({ files: [{ path }, { path: 'missing.txt' }] }, ctx)
        expect(failure.isError).toBe(true)
        expect(events).toHaveLength(1)
        expect(ctx.calls.invoke).toHaveLength(ui === 'disabled' ? 0 : 1)
        expect(ctx.calls.artifacts).toHaveLength(1)
        expect(new TextDecoder().decode(await base.fs.read(path))).toBe('<h1>城市</h1>')
        await base.fs.write(path, 'changed after presentation')
        expect(new TextDecoder().decode(ctx.calls.artifacts[0]!.bytes)).toBe('<h1>城市</h1>')
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    },
  )
})
