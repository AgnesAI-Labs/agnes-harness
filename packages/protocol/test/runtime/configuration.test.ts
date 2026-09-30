import { describe, expect, it } from 'vitest'
import { RuntimeConfigurationSchemas, validateRuntime } from '../../src/runtime/index.js'

describe('Runtime configuration schemas', () => {
  it('publishes every configuration root without accepting incomplete documents', () => {
    expect(RuntimeConfigurationSchemas).toEqual([
      'RuntimeEmptyAuthorConfig',
      'RuntimeProfile',
      'RuntimePreset',
      'RuntimePluginManifest',
      'RuntimeSimpleLoopCheckpoint',
    ])
    for (const name of RuntimeConfigurationSchemas) {
      expect(validateRuntime(name, {}).ok).toBe(name === 'RuntimeEmptyAuthorConfig')
      expect(validateRuntime(name, { unknown: true }).ok).toBe(false)
    }
  })

  it('checks the complete preset shape and refuses manifest and profile documents in its place', () => {
    const preset = {
      $schema: 'https://agnes.ai/schema/runtime/v1/preset.schema.json',
      kind: 'agh.preset',
      schemaVersion: '1.0',
      id: 'preset',
      revision: 1,
      selections: [],
      configOverrides: [],
      parameters: {
        schema: { typeId: 'agh.sdk/empty-config@1', revision: 1, digest: 'a'.repeat(64) },
        value: {},
      },
      restrictions: { capabilityCeiling: [], limits: {} },
    }
    expect(validateRuntime('RuntimePreset', preset).ok).toBe(true)
    expect(validateRuntime('RuntimePreset', { ...preset, revision: 0 }).ok).toBe(false)
    expect(validateRuntime('RuntimePreset', { ...preset, kind: 'agh.profile' }).ok).toBe(false)
    expect(validateRuntime('RuntimePreset', { ...preset, parameters: { hidden: () => null } }).ok).toBe(false)
    expect(
      validateRuntime('RuntimePreset', {
        ...preset,
        restrictions: { ...preset.restrictions, escalate: true },
      }).ok,
    ).toBe(false)
    expect(validateRuntime('RuntimeProfile', preset).ok).toBe(false)
    expect(validateRuntime('RuntimePluginManifest', preset).ok).toBe(false)
  })
})
