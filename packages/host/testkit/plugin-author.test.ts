import { createPluginTestRegistration } from '@agnes/host/testkit'
import { createPluginTestHost as mountAuthor } from '@agnes/host/author-testkit'
import { type Context, defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import { createPluginTestHost } from '@agnes/plugin-runtime/testkit'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'

const tool = defineTool({
  name: 'author_echo',
  description: 'Echo text.',
  parameters: Type.Object({ text: Type.String() }),
  result: Type.Object({ text: Type.String() }),
  meta: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: false,
    replay: 'safe',
    costHint: undefined,
    deferLoading: undefined,
    requiresApproval: 'never',
  },
  async execute(args, ctx) {
    ctx.signal.throwIfAborted()
    return { content: [], structured: args }
  },
})

describe('plugin author host', () => {
  it('uses real Host registration, validates inputs, and unloads tools and plugin effects', async () => {
    // JavaScript authors also receive a clear refusal when they omit the required port.
    // @ts-expect-error deliberately exercise the missing JavaScript options argument
    await expect(createPluginTestHost(defineAgnesPlugin({ apply() {} }))).rejects.toThrow(
      'Plugin test registration required',
    )
    let cleaned = false
    const host = await createPluginTestHost(
      defineAgnesPlugin({
        inject: ['extension'],
        apply(ctx: Context) {
          ctx.extension().registerTool(tool)
          ctx.effect(() => () => {
            cleaned = true
          })
        },
      }),
      { registration: createPluginTestRegistration() },
    )
    try {
      expect(await host.invoke('author_echo', { text: 'hello' })).toMatchObject({
        structured: { text: 'hello' },
      })
      await expect(host.invoke('author_echo', { text: 1 })).rejects.toThrow('Invalid arguments')
      await expect(host.invoke('missing', {})).rejects.toThrow('not registered')
      const ac = new AbortController()
      ac.abort(new DOMException('Cancelled', 'AbortError'))
      await expect(host.invoke('author_echo', { text: 'hello' }, ac.signal)).rejects.toThrow('Cancelled')
    } finally {
      await host.dispose()
    }
    expect(cleaned).toBe(true)
    expect(host.tools.size).toBe(0)
    await expect(host.invoke('author_echo', { text: 'hello' })).rejects.toThrow('disposed')
    await host.dispose()
  })

  it('rejects registration failures and releases effects of a failed plugin', async () => {
    let cleaned = false
    await expect(
      createPluginTestHost(
        {
          inject: ['extension'],
          apply(ctx: Context) {
            ctx.effect(() => () => {
              cleaned = true
            })
            ctx.extension().registerTool(tool)
            ctx.extension().registerTool(tool)
          },
        },
        { registration: createPluginTestRegistration() },
      ),
    ).rejects.toThrow()
    expect(cleaned).toBe(true)
    cleaned = false
    const bridge = createPluginTestRegistration()
    await expect(
      mountAuthor(
        { apply() {} },
        {
          registration: {
            ...bridge,
            install(root, origins) {
              bridge.install(root, origins)
              root.effect(() => () => {
                cleaned = true
              })
              throw new Error('Service installation failed')
            },
          },
        },
      ),
    ).rejects.toThrow('Service installation failed')
    expect(cleaned).toBe(true)
  })
})
