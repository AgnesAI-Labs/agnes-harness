import { describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { ModelChooser } from '../src/model-chooser.js'

const models = [
  { route: 'r', id: 'a', reasoning: true },
  { route: 'r', id: 'b' },
]
const flush = () => new Promise((done) => setTimeout(done, 0))

function chooserWith(setModel: () => Promise<{ effectiveFromSeq: number }>) {
  const showError = vi.fn()
  const app = {
    locale: 'en',
    showError,
    session: { setModel, client: { apis: async () => ({ profile: { models } }) } },
    statusBar: { setNotice: vi.fn() },
    renderer: { requestRender: vi.fn() },
  } as unknown as TuiApp
  return {
    chooser: new ModelChooser(
      app,
      () => false,
      () => false,
    ),
    showError,
  }
}

describe('ModelChooser', () => {
  it('keeps the model it last knew when switching fails, so the next cycle starts from there', async () => {
    const { chooser, showError } = chooserWith(async () => {
      throw new Error('refused')
    })
    chooser.current = { route: 'r', id: 'a', thinking: '' }
    chooser.cycleModel(1)
    await flush()
    expect(showError).toHaveBeenCalled()
    expect(chooser.current).toEqual({ route: 'r', id: 'a', thinking: '' })
  })

  it('moves to the new model when switching works', async () => {
    const { chooser } = chooserWith(async () => ({ effectiveFromSeq: 1 }))
    chooser.current = { route: 'r', id: 'a', thinking: '' }
    chooser.cycleModel(1)
    await flush()
    expect(chooser.current).toMatchObject({ id: 'b' })
  })
})
