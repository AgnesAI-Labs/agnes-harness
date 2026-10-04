import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import type {
  ClientModule,
  ClientModuleContribution,
  ClientSelection,
  ClientWelcome,
} from '../../src/runtime/index.js'
import { RuntimeMethodSchemaRefs, validateRuntime } from '../../src/runtime/index.js'
import { runtimeSchemaDocument } from '../../src/runtime/schema-document.js'
import { loadRuntimeSchemaGraph } from '../../tools/gen-runtime-full.js'

const directory = `${import.meta.dirname}/../../schema/runtime`
const graph = loadRuntimeSchemaGraph(directory)
const digest = 'a'.repeat(64)
const reference = { packageId: 'client-package', contributionId: 'registry' }
const selection: ClientSelection = {
  target: 'web',
  shell: { ...reference, contributionId: 'shell' },
  registry: reference,
  fallbackRenderer: { ...reference, contributionId: 'fallback' },
  rendererSelections: [{ renderKey: 'message', rendererId: 'message-renderer', target: 'web' }],
}
const contribution: ClientModuleContribution = {
  contributionId: 'message-renderer',
  kind: 'renderer',
  targets: ['web', 'tui', 'im', 'sdk'],
}
const module: ClientModule = {
  moduleId: 'client-module',
  packageId: reference.packageId,
  packageDigest: digest,
  assetDigest: digest,
  entryPath: './client.js',
  ownerToken: 'generation',
  authorApiMajor: 1,
  targets: ['web'],
  schemas: [],
  requiredFeatures: [],
  styles: [],
}
const welcome: ClientWelcome = {
  negotiatedSession: 'transport-session',
  clientInstanceId: 'client-instance',
  wireVersion: { major: 1, minor: 0 },
  catalogRevision: 1,
  domainSchemas: [],
  modules: [module],
  mode: 'compatible',
  reasons: [],
  capabilities: {
    clientInstanceId: 'client-instance',
    negotiatedSession: 'transport-session',
    target: 'web',
    protocols: [],
    viewSchemaRanges: [],
    renderKeys: [],
    features: [],
    capabilitiesRevision: 1,
    effectivePolicyRevision: 1,
    interaction: {
      text: true,
      singleChoice: true,
      multiChoice: true,
      confirm: true,
      complexFormLink: false,
    },
    files: { link: true, upload: false, maxUploadBytes: 0, allowedMimes: [] },
    display: { plainText: true, markdown: false, maxTextBytes: 1024, inlinePreviewMimes: [] },
  },
}

describe('client selection wire values', () => {
  it('keeps old Welcome and Module readable and accepts the optional contribution projection', () => {
    expect(validateRuntime('ClientModule', module).ok).toBe(true)
    expect(validateRuntime('ClientWelcome', welcome).ok).toBe(true)
    const selectedModule = { ...module, contributions: [contribution] }
    expect(validateRuntime('ClientModule', selectedModule).ok).toBe(true)
    expect(
      validateRuntime('ClientWelcome', { ...welcome, modules: [selectedModule], clientSelection: selection })
        .ok,
    ).toBe(true)
    expect(validateRuntime('ClientModule', { ...module, contributions: null }).ok).toBe(false)
    expect(validateRuntime('ClientWelcome', { ...welcome, clientSelection: null }).ok).toBe(false)
  })

  it('requires a Web shell and explicitly omits a shell for the other three targets', () => {
    expect(validateRuntime('ClientSelection', selection).ok).toBe(true)
    expect(validateRuntime('ClientSelection', { ...selection, shell: null }).ok).toBe(false)
    for (const target of ['tui', 'im', 'sdk'] as const) {
      const selected = { ...selection, target, shell: null, rendererSelections: [] }
      expect(validateRuntime('ClientSelection', selected).ok).toBe(true)
      expect(validateRuntime('ClientSelection', { ...selected, shell: selection.shell }).ok).toBe(false)
    }
    expect(validateRuntime('ClientSelection', { ...selection, target: 'desktop' }).ok).toBe(false)
  })

  it('closes selection, contribution and package-reference identities without creating entry aliases', () => {
    for (const invalid of [
      { ...reference, packageId: '' },
      { ...reference, contributionId: '' },
      { ...reference, contributionId: 'bad\u0000id' },
      { ...reference, packageId: 'x'.repeat(257) },
      { ...reference, entry: './registry.js' },
    ]) {
      expect(validateRuntime('ClientContributionRef', invalid).ok).toBe(false)
      expect(validateRuntime('ClientSelection', { ...selection, registry: invalid }).ok).toBe(false)
    }
    expect(validateRuntime('ClientSelection', { ...selection, extra: true }).ok).toBe(false)
    expect(validateRuntime('ClientModuleContribution', { ...contribution, entry: './renderer.js' }).ok).toBe(
      false,
    )
    expect(validateRuntime('ClientModuleContribution', { ...contribution, contributionId: '' }).ok).toBe(
      false,
    )
    expect(validateRuntime('ClientModuleContribution', { ...contribution, kind: 'tool' }).ok).toBe(false)
    for (const field of ['target', 'shell', 'registry', 'fallbackRenderer', 'rendererSelections']) {
      const incomplete = { ...selection }
      Reflect.deleteProperty(incomplete, field)
      expect(validateRuntime('ClientSelection', incomplete).ok).toBe(false)
    }
  })

  it('bounds contribution targets and limits shells to Web without relaxing registry or renderer targets', () => {
    for (const kind of ['registry', 'renderer'] as const) {
      expect(validateRuntime('ClientModuleContribution', { ...contribution, kind }).ok).toBe(true)
      for (const targets of [[], ['web', 'web'], ['desktop'], ['web', 'tui', 'im', 'sdk', 'web']])
        expect(validateRuntime('ClientModuleContribution', { ...contribution, kind, targets }).ok).toBe(false)
    }
    expect(
      validateRuntime('ClientModuleContribution', {
        contributionId: 'shell',
        kind: 'shell',
        targets: ['web'],
      }).ok,
    ).toBe(true)
    for (const targets of [[], ['tui'], ['web', 'tui'], ['web', 'web']])
      expect(
        validateRuntime('ClientModuleContribution', { contributionId: 'shell', kind: 'shell', targets }).ok,
      ).toBe(false)
  })

  it('enforces the 128 contribution and renderer-selection collection limits', () => {
    for (const count of [128, 129]) {
      expect(
        validateRuntime('ClientModule', {
          ...module,
          contributions: Array.from({ length: count }, (_, i) => ({
            ...contribution,
            contributionId: `r${i}`,
          })),
        }).ok,
      ).toBe(count === 128)
      expect(
        validateRuntime('ClientSelection', {
          ...selection,
          rendererSelections: Array.from({ length: count }, (_, i) => ({
            renderKey: `key${i}`,
            rendererId: `renderer${i}`,
            target: 'web',
          })),
        }).ok,
      ).toBe(count === 128)
    }
  })

  it('retains rendererId and rejects a second package identity or an entry in renderer selections', () => {
    const renderer = selection.rendererSelections[0]
    for (const invalid of [
      { ...renderer, rendererId: '' },
      { ...renderer, renderKey: '' },
      { ...renderer, target: 'desktop' },
      { ...renderer, contributionId: renderer?.rendererId },
      { ...renderer, packageId: reference.packageId },
      { ...renderer, entry: './renderer.js' },
    ])
      expect(validateRuntime('ClientSelection', { ...selection, rendererSelections: [invalid] }).ok).toBe(
        false,
      )
  })

  it('uses the existing Profile contribution references and original manifest ids', () => {
    const ajv = new Ajv2020({ strict: false })
    const profileDocument = runtimeSchemaDocument(graph.document, 'RuntimeProfile')
    const profileClient = ajv.compile({
      ...profileDocument,
      $ref: '#/$defs/RuntimeProfile/properties/client',
    })
    expect(profileClient({ ...selection, target: undefined, requiredTargets: ['web'] })).toBe(false)
    const { target: _target, ...client } = selection
    expect(profileClient({ ...client, requiredTargets: ['web'] })).toBe(true)
    const manifestDocument = runtimeSchemaDocument(graph.document, 'RuntimePluginManifest')
    const services = ajv.compile({
      ...manifestDocument,
      $ref: '#/$defs/RuntimePluginManifest/anyOf/1/properties/clientServices',
    })
    const service = {
      id: 'registry',
      packageDigest: digest,
      contract: 'agh.ui-registry',
      apiMajor: 1,
      targets: ['web'],
      scope: 'client',
      configSchema: { typeId: 'demo/config@1', revision: 1, digest },
      entry: { entry: './registry.js', export: 'registry' },
      requiredFeatures: [],
    }
    expect(services([service])).toBe(true)
    expect(services([{ ...service, contributionId: service.id }])).toBe(false)
    const renderer = {
      id: contribution.contributionId,
      packageDigest: digest,
      renderKey: 'message',
      targets: contribution.targets,
      viewSchemaRanges: [{ typeId: 'demo/view@1', minRevision: 1, maxRevision: 1 }],
      requiredFeatures: [],
      optionalFeatures: [],
      scope: 'client',
      entry: './renderer.js',
    }
    expect(validateRuntime('RendererDescriptor', renderer).ok).toBe(true)
    expect(validateRuntime('RendererDescriptor', { ...renderer, contributionId: renderer.id }).ok).toBe(false)
    expect(
      validateRuntime('ClientContributionRef', { packageId: module.packageId, contributionId: service.id })
        .ok,
    ).toBe(true)
  })

  it('records the complete changed closure at revision four and new helpers at revision one', () => {
    const document = JSON.parse(readFileSync(`${directory}/public.json`, 'utf8'))
    for (const name of [
      'ClientModule',
      'ClientWelcome',
      'ClientBootstrapAccepted',
      'ClientBootstrapResult',
      'ClientCatalogPageResult',
    ])
      expect(document['x-schema-revisions'][name]).toBe(4)
    for (const name of ['ClientContributionRef', 'ClientModuleContribution', 'ClientSelection']) {
      expect(document['x-schema-revisions'][name]).toBe(1)
      expect(document['x-schema-ids'][name]).toBeUndefined()
    }
    const hello = RuntimeMethodSchemaRefs['agh.transport'].handshake
    expect(hello.output.revision).toBe(4)
  })
})
