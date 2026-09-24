import { describe, expect, it } from 'vitest'
import {
  accountDefaultModel,
  mergeComposerMemory,
  parseComposerMemory,
  resolveNewSessionSelection,
} from '../src/composer-selection.js'

const models = [
  { route: 'deepseek', id: 'deepseek-v4-flash' },
  { route: 'deepseek', id: 'deepseek-v4-pro' },
]

describe('composer selection', () => {
  it('keeps a remembered model and permission that are still available', () => {
    expect(
      resolveNewSessionSelection({
        remembered: {
          model: { route: 'deepseek', id: 'deepseek-v4-pro', thinking: 'medium' },
          permission: 'full',
        },
        models,
        accountDefault: { route: 'deepseek', id: 'deepseek-v4-flash' },
      }),
    ).toEqual({
      model: { route: 'deepseek', id: 'deepseek-v4-pro', thinking: 'medium' },
      permission: 'full',
    })
  })

  it('falls back to the account default when nothing was remembered or the model left the catalog', () => {
    const accountDefault = accountDefaultModel(models, { route: 'deepseek', model: 'deepseek-v4-flash' })
    expect(
      resolveNewSessionSelection({
        remembered: { model: { route: 'deepseek', id: 'retired' }, permission: 'view' },
        models,
        ...(accountDefault ? { accountDefault } : {}),
      }),
    ).toEqual({ model: { route: 'deepseek', id: 'deepseek-v4-flash' }, permission: 'view' })
    expect(resolveNewSessionSelection({ remembered: undefined, models })).toEqual({
      permission: 'workspace',
    })
  })

  it('merges a later choice without erasing the other field and rejects a corrupt record', () => {
    const first = models[0]
    if (!first) throw new Error('fixture model missing')
    expect(mergeComposerMemory({ model: first, permission: 'workspace' }, { permission: 'full' })).toEqual({
      model: first,
      permission: 'full',
    })
    expect(
      parseComposerMemory({
        model: { route: 'deepseek', id: 'deepseek-v4-pro', thinking: 'high' },
        permission: 'nope',
      }),
    ).toEqual({
      model: { route: 'deepseek', id: 'deepseek-v4-pro', thinking: 'high' },
    })
    expect(parseComposerMemory({ permission: 'full', extra: true })).toEqual({ permission: 'full' })
    expect(parseComposerMemory(null)).toBeUndefined()
    expect(parseComposerMemory({ model: { route: '', id: 'x' } })).toBeUndefined()
  })
})
