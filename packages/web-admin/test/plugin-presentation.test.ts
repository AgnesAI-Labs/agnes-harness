import type {
  CompositionCapabilitySnapshot,
  PackageInstalledDescriptor,
  RuntimeAdminSnapshot,
} from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { matchesPluginSearch, pluginPresentation } from '../src/admin/plugins/admin/presentation.js'

const item: PackageInstalledDescriptor = {
  id: '@acme/research',
  version: '1.0.0',
  integrity: 'sha256-' + 'a'.repeat(64),
  source: { type: 'file', ref: 'file:./research' },
  trusted: true,
  desired: 'enabled',
  actual: 'running',
  blockers: [],
  metadata: {
    displayName: 'Research desk',
    summary: 'Find answers in project documents.',
    description: 'Search project documents.',
    category: 'tools',
    locales: { 'zh-CN': { displayName: '资料研究', summary: '在项目资料中查找答案。' } },
  },
  contributions: [
    {
      kind: 'extension',
      id: 'acme/research',
      path: './manifest.json',
      apiRange: '^1.0',
      capabilities: { tools: { prefix: '', names: ['unregistered_claim'] }, events: true },
    },
  ],
  presentation: { origin: 'local-source', rows: [{ id: 'ext:acme/research', settings: true }] },
}
const runtime: RuntimeAdminSnapshot = {
  providers: [
    {
      kind: 'loop',
      id: 'research.loop',
      version: '1.0.0',
      sourcePackage: item.id,
      capabilities: [],
      restartRequired: false,
      scope: 'session',
      active: false,
      selectedFor: [],
    },
    {
      kind: 'tool-policy',
      id: 'other.policy',
      version: '1.0.0',
      sourcePackage: '@other/package',
      capabilities: [],
      restartRequired: false,
      active: true,
      selectedFor: [],
    },
  ],
  presets: [],
  localPluginFolders: { home: '/synthetic/home', workspace: '/synthetic/workspace' },
}
const composition: CompositionCapabilitySnapshot = {
  status: 'live',
  validation: 'static',
  sessions: [
    {
      sessionKey: 'fixture:one',
      compositionHash: 'fixture',
      preset: 'read-only',
      bundles: [],
      toolGroups: [{ packageId: item.id, reason: 'enabled-plugin', bundles: [], tools: ['read_report'] }],
    },
    {
      sessionKey: 'fixture:two',
      compositionHash: 'fixture',
      preset: 'read-only',
      bundles: [],
      toolGroups: [{ packageId: item.id, reason: 'enabled-plugin', bundles: [], tools: ['read_report'] }],
    },
  ],
}

describe('read-only plugin presentation', () => {
  it('uses real source-owned catalogs, deduplicates tools and maps registered UI/settings surfaces', () => {
    const result = pluginPresentation(item, {
      runtime,
      composition,
      slots: ['workbench.panel', 'conversation.approval.detail'],
      surfaces: [{ surfaceId: 'report' }],
    })
    expect(result.provides).toEqual(
      expect.arrayContaining([
        { kind: 'tool', id: 'read_report' },
        { kind: 'loop', id: 'research.loop', selected: false, scope: 'session' },
        { kind: 'panel', id: 'workbench.panel' },
        { kind: 'settings', id: 'ext:acme/research' },
        { kind: 'surface', id: 'report' },
      ]),
    )
    expect(result.provides.filter((entry) => entry.kind === 'tool')).toHaveLength(1)
    expect(result.provides.some((entry) => ['unregistered_claim', 'other.policy'].includes(entry.id))).toBe(
      false,
    )
    expect(result.appearsIn).toEqual(
      expect.arrayContaining(['chat', 'background', 'workbench', 'approval', 'settings', 'page']),
    )
  })
  it('does not infer active tools from declarations, disabled state or a different running revision', () => {
    const noSchema = { ...item, presentation: { rows: [] } }
    expect(pluginPresentation(noSchema).provides).toEqual([])
    expect(
      pluginPresentation({ ...noSchema, actual: 'not-running' }, { runtime, composition }).provides,
    ).toEqual([])
    expect(
      pluginPresentation(
        { ...noSchema, actualIntegrity: 'sha256-' + 'b'.repeat(64) },
        { runtime, composition },
      ).provides,
    ).toEqual([])
    expect(pluginPresentation(noSchema).available).toBe(false)
    expect(
      pluginPresentation(noSchema, { composition: { ...composition, status: 'desired' } }).provides,
    ).toEqual([])
  })
  it('searches bilingual purpose, row purpose and registered contribution IDs and labels', () => {
    const value = pluginPresentation(item, { runtime, composition })
    for (const query of ['Research desk', '查找答案', 'read_report', 'research.loop', 'ext:acme/research'])
      expect(matchesPluginSearch(item, query, value)).toBe(true)
    expect(
      matchesPluginSearch(
        item,
        '策略',
        { provides: [{ kind: 'tool-policy', id: 'policy' }], appearsIn: [], available: true },
        () => '策略',
      ),
    ).toBe(true)
    expect(matchesPluginSearch(item, 'unregistered_claim', value)).toBe(false)
  })
})
