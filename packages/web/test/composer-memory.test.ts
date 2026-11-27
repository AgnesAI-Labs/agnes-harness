/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rememberWebComposer, selectionFromMemory, setLocalComposerModels } from '../src/composer-memory.js'

afterEach(() => {
  setLocalComposerModels([])
  localStorage.clear()
  vi.unstubAllGlobals()
})

const demo = { route: 'demo', id: 'demo-model' }
const real = { route: 'account-1', id: 'real-model' }
const other = { route: 'account-2', id: 'other-model' }
const models = [demo, real, other]
beforeEach(() => setLocalComposerModels(models))

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

it('keeps local and remote model/permission memory separate', () => {
  vi.stubGlobal('location', new URL('http://localhost:4177/'))
  rememberWebComposer({ model: real, permission: 'view' })
  vi.stubGlobal('location', new URL('http://localhost:4177/?remote=http%3A%2F%2Fcomputer-b%3A8443'))
  rememberWebComposer({ model: other, permission: 'workspace' })
  expect(selectionFromMemory(models, null).model).toEqual(other)
  vi.stubGlobal('location', new URL('http://localhost:4177/'))
  expect(selectionFromMemory(models, null)).toEqual({ model: real, permission: 'view' })
})

it('does not replace native model memory while viewing a contributed cloud model on B', () => {
  vi.stubGlobal('location', new URL('http://localhost:4177/'))
  rememberWebComposer({ model: real, permission: 'view' })
  const cloud = { route: 'external-models', id: real.id }
  rememberWebComposer({ model: cloud })
  expect(selectionFromMemory(models, null)).toEqual({ model: real, permission: 'view' })
  rememberWebComposer({ model: cloud, permission: 'workspace' })
  expect(selectionFromMemory(models, null)).toEqual({ model: real, permission: 'workspace' })
  vi.stubGlobal('location', new URL('http://localhost:4177/?remote=http%3A%2F%2Fcomputer-b%3A8443'))
  rememberWebComposer({ model: cloud })
  expect(selectionFromMemory([cloud], null).model).toEqual(cloud)
})
