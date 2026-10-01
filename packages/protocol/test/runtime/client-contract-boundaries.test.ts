import { describe, expect, it } from 'vitest'
import { RuntimeServiceCatalog, validateRuntime } from '../../src/runtime/index.js'

const view = {
  kind: 'domain',
  viewId: 'view',
  revision: 1,
  domainType: 'demo/view@1',
  viewSchema: { typeId: 'demo/view@1', revision: 1, digest: 'a'.repeat(64) },
  renderKey: 'demo',
  scope: {
    kind: 'workspace',
    installationId: 'installation',
    runtimeId: 'runtime',
    workspaceId: 'workspace',
  },
  source: { eventIds: [], projectionRevision: 1 },
  phase: 'finalized',
  fallbackText: 'fallback',
  data: null,
  resources: [],
  actions: [],
}
const action = {
  kind: 'interaction',
  actionKey: 'answer',
  label: 'Answer',
  requiredFeatures: [],
  availability: 'enabled',
  disabledReason: null,
  interactionId: 'interaction',
  version: 1,
}
const resource = {
  artifactId: 'artifact',
  version: 1,
  title: 'Artifact',
  mime: 'text/plain',
  size: 1,
  status: 'ready',
}

describe('client contract boundaries', () => {
  it('accepts a complete view and refuses oversized action and resource collections', () => {
    expect(validateRuntime('DomainView', view).ok).toBe(true)
    for (const [field, item] of [
      ['actions', action],
      ['resources', resource],
    ] as const) {
      expect(
        validateRuntime('DomainView', { ...view, [field]: Array.from({ length: 32 }, () => item) }).ok,
      ).toBe(true)
      expect(
        validateRuntime('DomainView', { ...view, [field]: Array.from({ length: 33 }, () => item) }).ok,
      ).toBe(false)
    }
  })
  it('measures fallback text in UTF-8 bytes, including multibyte values', () => {
    for (const text of ['a'.repeat(4096), '😀'.repeat(1024)])
      expect(validateRuntime('DomainView', { ...view, fallbackText: text }).ok).toBe(true)
    for (const text of ['a'.repeat(4097), '😀'.repeat(1024) + 'a'])
      expect(validateRuntime('DomainView', { ...view, fallbackText: text }).ok).toBe(false)
  })
  it('does not advertise a command method absent from the shell domain client', () => {
    expect(RuntimeServiceCatalog['agh.shell'].methods).not.toHaveProperty('command')
    expect(RuntimeServiceCatalog['agh.shell'].methods.query).toMatchObject({
      local: true,
      localInterface: 'ShellDomainClient',
      localMethod: 'query',
    })
  })
})
