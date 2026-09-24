import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateExtensionManifest, validateMethod, validateServiceCapability } from '../src/index.js'
import { runFixtureFiles } from '../tools/conformance-core.js'

const capability = {
  name: 'report.query',
  kind: 'query',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  timeoutMs: 30000,
  maxResultBytes: 1048576,
}
const call = (input: unknown) =>
  validateMethod('_agnes/v1/extension.call', 'params', {
    sessionId: 'session-1',
    extension: 'acme/dashboard',
    service: 'report.query',
    input,
  })
describe('S1 Extension Service contract', () => {
  it('runs every positive and negative fixture through public validators', () => {
    const result = runFixtureFiles([
      fileURLToPath(new URL('../fixtures/extension-service/service.jsonl', import.meta.url)),
    ])
    expect(result.failed).toEqual([])
    expect(result.total).toBe(35)
    expect(result.skipped).toBe(0)
  })
  it('rejects duplicate names even when kind or limits differ', () => {
    const manifest = {
      id: 'acme/dashboard',
      version: '1.0.0',
      apiRange: '^1.0.0',
      entry: './index.js',
      capabilities: { services: [capability] },
    }
    expect(validateExtensionManifest(manifest).ok).toBe(true)
    manifest.capabilities.services.push({ ...capability, kind: 'effect' })
    expect(validateExtensionManifest(manifest).ok).toBe(false)
  })
  it('uses UTF-8 bytes and checks both input and output ceilings', () => {
    expect(call({ text: 'a'.repeat(1048576 - 11) }).ok).toBe(true)
    expect(call({ text: 'a'.repeat(1048576 - 10) }).ok).toBe(false)
    expect(call({ text: '\u4e2d'.repeat(400000) }).ok).toBe(false)
    expect(validateMethod('_agnes/v1/extension.call', 'result', { output: 'a'.repeat(1048575) }).ok).toBe(
      false,
    )
  })
  it('rejects non JSON, cycles and accessors without executing them', () => {
    let invoked = false
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const input of [
      { x: undefined },
      { x: Infinity },
      { x: () => 1 },
      cyclic,
      {
        get x() {
          invoked = true
          return 1
        },
      },
      {
        toJSON() {
          invoked = true
          return {}
        },
      },
      new Date(),
    ]) {
      expect(call(input).ok).toBe(false)
    }
    expect(invoked).toBe(false)
    expect(validateServiceCapability({ ...capability, timeoutMs: Infinity }).ok).toBe(false)
  })
})
