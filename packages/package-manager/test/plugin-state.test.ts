import { expect, it } from 'vitest'
import { publicPluginFailureReason } from '../src/plugin-state.js'

it.each([
  ['missing export main /private/path', 'Plugin export is missing.'],
  ['API range mismatch', 'Plugin API range is incompatible.'],
  ['missing inject clock', 'A required plugin service is missing.'],
  ['schema error secret=hidden', 'Plugin configuration schema is invalid.'],
  ['capability blocked exec', 'Plugin capability policy blocked activation.'],
  ['frontend load failure', 'Plugin frontend could not be loaded.'],
  ['private path secret=hidden', 'Runtime activation failed.'],
])('projects safe diagnostics for %s', (input, expected) => {
  expect(publicPluginFailureReason(input)).toBe(expected)
})
