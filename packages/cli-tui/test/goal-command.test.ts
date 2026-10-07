import { describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'

describe('/goal', () => {
  it('reads the public projection and sends mutations through ordinary prompt/steer input', async () => {
    const session = {
      projectUIOpening: vi.fn(async () => ({ timeline: { nodes: [] } })),
      prompt: vi.fn(async () => ({})),
      steer: vi.fn(async () => 1),
    }
    const app = { session, busy: false } as unknown as TuiApp
    expect(await runSlash(app, '/goal')).toMatchObject({ text: 'No goal' })
    await runSlash(app, '/goal create Finish')
    expect(session.prompt).toHaveBeenCalledWith('/goal create Finish')
    Object.assign(app, { busy: true })
    await runSlash(app, '/goal pause')
    expect(session.steer).toHaveBeenCalledWith('/goal pause')
  })
})
