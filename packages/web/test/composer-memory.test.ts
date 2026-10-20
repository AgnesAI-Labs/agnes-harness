/** @vitest-environment happy-dom */
import { afterEach, expect, it } from 'vitest'
import { rememberWebComposer, selectionFromMemory } from '../src/composer-memory.js'

afterEach(() => localStorage.clear())

const demo = { route: 'demo', id: 'demo-model' }
const real = { route: 'account-1', id: 'real-model' }
const other = { route: 'account-2', id: 'other-model' }
const models = [demo, real, other]

it.each([
  { remembered: demo, provider: null, expected: demo },
  { remembered: demo, provider: { route: real.route, model: real.id }, expected: real },
  { remembered: demo, provider: { route: real.route, model: 'unavailable' }, expected: demo },
  { remembered: demo, provider: { route: demo.route, model: demo.id }, expected: demo },
  { remembered: other, provider: { route: real.route, model: real.id }, expected: other },
])(
  'restores a starter choice while allowing a real account default to replace it (%j)',
  ({ remembered, provider, expected }) => {
    rememberWebComposer({ permission: 'view' })
    rememberWebComposer({ model: remembered })
    expect(selectionFromMemory(models, provider)).toEqual({ model: expected, permission: 'view' })
    // Resolving a future draft does not rewrite another open session or the saved user preference.
    expect(selectionFromMemory(models, null).model).toEqual(remembered)
  },
)
