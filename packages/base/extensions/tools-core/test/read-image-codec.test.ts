import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'

// A machine whose native image library cannot load: a build for another C library or architecture,
// or an install without optional dependencies. Loading it throws, as `require('sharp')` does there.
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  const createRequire = (from: string | URL) => {
    const real = actual.createRequire(from)
    return Object.assign((id: string) => {
      if (id === 'sharp') throw new Error('Could not load the "sharp" module using the linuxmusl-x64 runtime')
      return real(id)
    }, real)
  }
  return { ...actual, createRequire, default: { ...actual, createRequire } }
})

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
])
const textOf = (result: ToolResult): string =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
const imageCtx = (files: Record<string, Uint8Array | string>) => {
  const base = fakeToolContext({ files })
  const sent: unknown[] = []
  const policy = { maxWidth: 1456, maxHeight: 1456, maxBytes: 4 * 1024 * 1024, maxPixels: 1456 * 1456 }
  const ctx = {
    ...base,
    session: {
      ...base.session,
      imageInputPolicy: async () => ({ ...policy, supported: true }),
      imageInput: async (input: unknown): Promise<ToolResult> => {
        sent.push(input)
        return { content: [{ type: 'text', text: 'image accepted' }] }
      },
    },
  } as ToolContext
  return { ctx, sent }
}

describe('read without a loadable image library', () => {
  it('still loads the tools, so sessions start', async () => {
    const tools = await import('../src/index.js')
    expect(tools.TOOLS_CORE.map((tool) => tool.name)).toContain('read')
  })

  it('answers an image read with an error and sends no pixels', async () => {
    const { readTool } = await import('../src/tools/read.js')
    const { ctx, sent } = imageCtx({ 'photo.png': PNG })
    const result = await readTool.execute({ path: 'photo.png' }, ctx)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(
      'Image read failed: the image library could not be loaded on this machine. Image pixels were not inspected.',
    )
    expect(sent).toEqual([])
  })

  it('reads text files as usual', async () => {
    const { readTool } = await import('../src/tools/read.js')
    const { ctx } = imageCtx({ 'notes.txt': 'first line\nsecond line\n' })
    const result = await readTool.execute({ path: 'notes.txt' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toBe('1\tfirst line\n2\tsecond line')
  })
})
