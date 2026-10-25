import { describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'

describe('/goal', () => {
  it('reads the public projection and hands mutations back as ordinary input for the app to send', async () => {
    const session = { projectUIOpening: vi.fn(async () => ({ timeline: { nodes: [] } })) }
    const app = { session, busy: false } as unknown as TuiApp
    expect(await runSlash(app, '/goal')).toMatchObject({ text: 'No goal' })
    expect(await runSlash(app, '/goal create Finish')).toEqual({
      content: [{ type: 'text', text: '/goal create Finish' }],
      steer: true,
    })
  })
})
