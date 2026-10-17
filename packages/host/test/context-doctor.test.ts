import type { PluginContextFacets } from '@agnes/extension-api'
import { DEFAULT_LOOP } from '@agnes/extension-api'
import { createAuthorTestkit } from '@agnes/host/author-testkit'
import type { Context } from '@agnes/plugin-runtime'
import { expect, it } from 'vitest'

it('runs the installed context observer with a fake model, scoped events and the ordinary public loop', async () => {
  const url = new URL('../../context-doctor/index.mjs', import.meta.url)
  const module: { main: { apply(ctx: PluginContextFacets): () => void } } = await import(url.href)
  const kit = await createAuthorTestkit({
    plugin: {
      inject: ['hooks', 'projections', 'services', 'eventLog', 'self'],
      apply(ctx: Context) {
        return module.main.apply(ctx)
      },
    },
    version: '1.0.0',
    loop: DEFAULT_LOOP,
    replies: [
      [
        { type: 'text_delta', delta: 'Offline answer' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  try {
    const session = await kit.openSession()
    await session.enqueue('synthetic private input 中文 and English')
    await session.drive(12)
    const facts = await session.facts()
    const snapshots = facts.filter(
      (event) => event.type.startsWith('x/plugin/') && event.type.endsWith('/snapshot'),
    )
    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots.at(-1)?.data).toMatchObject({ request: { slot: 'main' } })
    expect(JSON.stringify(snapshots.map((event) => event.data))).not.toContain('synthetic private input')
    expect(JSON.stringify(snapshots.map((event) => event.data))).not.toContain('Offline answer')
    expect(facts.some((event) => event.type === 'assistant/message')).toBe(true)
    expect(await session.effects()).toEqual([])
  } finally {
    await kit.dispose()
  }
})
