import { describe, expect, it } from 'vitest'
import { parseApplicationContract } from '../src/application-contract.js'
import { parsePackageBundleContract, preflightPackageBundles } from '../src/bundle-contract.js'
import { parseAgnesPluginEntries, parseAgnesPluginProvides } from '../src/plugin-manifest.js'

const purpose = {
  displayName: 'File search',
  summary: 'Find project text.',
  description: 'Find text in readable project files.',
  locales: { 'zh-CN': { displayName: '文件搜索', summary: '检索项目文本。' } },
}

describe('package.json agnes.plugins', () => {
  it('normalizes the author shape with a required contract range and freezes the result', () => {
    const entries = parseAgnesPluginEntries('@acme/example', [
      { apiRange: '^4.0.0', export: 'main' },
      {
        apiRange: '^4.0.0',
        export: 'optional',
        id: 'ext:acme/optional',
        runtime: 'isolated',
        config: { enabled: true },
        default: false,
      },
    ])

    expect(entries).toEqual([
      {
        apiRange: '^4.0.0',
        export: 'main',
        id: 'ext:@acme/example/main',
        runtime: 'in-process',
        default: true,
      },
      {
        apiRange: '^4.0.0',
        export: 'optional',
        id: 'ext:acme/optional',
        runtime: 'isolated',
        config: { enabled: true },
        default: false,
      },
    ])
    expect(Object.isFrozen(entries)).toBe(true)
    expect(Object.isFrozen(entries[0])).toBe(true)
  })

  it.each([
    [[{ export: 'missing-range' }], 'apiRange'],
    [[{ export: 'incompatible', apiRange: '^99.0.0' }], 'apiRange'],
    [null, 'list'],
    [{ apiRange: '^4.0.0', export: 'main' }, 'list'],
    [[{}], 'export'],
    [[{ apiRange: '^4.0.0', export: '' }], 'export'],
    [[{ apiRange: '^4.0.0', export: 'main', runtime: 'worker' }], 'runtime'],
    [[{ apiRange: '^4.0.0', export: 'main', default: 'yes' }], 'default'],
    [[{ apiRange: '^4.0.0', export: 'main', extra: true }], 'unknown'],
    [[{ apiRange: '^4.0.0', export: 'main', configReload: 'restart' }], 'configReload'],
    [[{ apiRange: '^4.0.0', export: 'main', configSchema: { type: 'invalid' } }], 'JSON Schema'],
    [[{ apiRange: '^4.0.0', export: 'main', configSchema: { type: 'integer' }, config: 'bad' }], 'config'],
    [
      [
        {
          apiRange: '^4.0.0',
          export: 'main',
          configSchema: { type: 'string', writeOnly: true },
          config: 'synthetic-plaintext',
        },
      ],
      'config',
    ],
    [[{ apiRange: '^4.0.0', export: 'main', id: '../escape' }], 'id'],
  ])('rejects invalid input %j', (value, message) => {
    expect(() => parseAgnesPluginEntries('@acme/example', value)).toThrow(message)
  })

  it('preserves localized row purpose in a frozen independent author snapshot', () => {
    const [row] = parseAgnesPluginEntries('@acme/example', [
      { export: 'main', apiRange: '^4.0.0', metadata: purpose },
    ])
    expect(row?.metadata).toEqual(purpose)
    expect(row?.metadata).not.toBe(purpose)
    expect(Object.isFrozen(row?.metadata?.locales?.['zh-CN'])).toBe(true)
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [
        { export: 'main', apiRange: '^4.0.0', metadata: { ...purpose, category: 'invented' } },
      ]),
    ).toThrow('metadata')
  })

  it('rejects duplicate normalized ids', () => {
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [
        { apiRange: '^4.0.0', export: 'main' },
        { apiRange: '^4.0.0', export: 'other', id: 'ext:@acme/example/main' },
      ]),
    ).toThrow(/duplicate/i)
  })

  it('rejects package-authored web rows because that namespace belongs to the daemon', () => {
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [
        { apiRange: '^4.0.0', export: 'panel', id: 'web:@victim/example' },
      ]),
    ).toThrow(/web:.*reserved/i)
  })

  it('rejects non-JSON and cyclic config values', () => {
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [{ apiRange: '^4.0.0', export: 'main', config: () => 1 }]),
    ).toThrow(/config/i)
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [{ apiRange: '^4.0.0', export: 'main', config: Number.NaN }]),
    ).toThrow(/config/i)
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [{ apiRange: '^4.0.0', export: 'main', config: cyclic }]),
    ).toThrow(/cyclic/i)
  })

  it('returns an empty frozen list when plugins are omitted', () => {
    const entries = parseAgnesPluginEntries('@acme/example', undefined)
    expect(entries).toEqual([])
    expect(Object.isFrozen(entries)).toBe(true)
  })

  it('accepts declared provide and inject service names and freezes them', () => {
    const [entry] = parseAgnesPluginEntries('@acme/example', [
      { apiRange: '^4.0.0', export: 'main', provide: ['acmeStats'], inject: ['clock', 'seam:approval'] },
    ])
    expect(entry?.provide).toEqual(['acmeStats'])
    expect(entry?.inject).toEqual(['clock', 'seam:approval'])
    expect(Object.isFrozen(entry?.provide)).toBe(true)
    expect(Object.isFrozen(entry?.inject)).toBe(true)
  })

  it('separates Surface-callable services from Cordis provide names', () => {
    const [entry] = parseAgnesPluginEntries('@acme/example', [
      { apiRange: '^4.0.0', export: 'main', provide: ['clock'], services: ['data.read'] },
    ])
    expect(entry?.provide).toEqual(['clock'])
    expect(entry?.services).toEqual(['data.read'])
    expect(Object.isFrozen(entry?.services)).toBe(true)
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [
        { apiRange: '^4.0.0', export: 'main', services: ['Bad/Name'] },
      ]),
    ).toThrow(/Surface service name syntax/)
  })

  it('leaves provide and inject absent when the author declares neither', () => {
    const [entry] = parseAgnesPluginEntries('@acme/example', [{ apiRange: '^4.0.0', export: 'main' }])
    expect(entry).not.toHaveProperty('provide')
    expect(entry).not.toHaveProperty('inject')
  })

  it.each([
    ['not an array', 'abc'],
    ['a non-string name', [1]],
    ['an empty name', ['']],
    ['a padded name', [' stats']],
    ['a control character', ['a\u0000b']],
    ['a duplicate name', ['stats', 'stats']],
    ['too many names', Array.from({ length: 65 }, (_, index) => `s${index}`)],
    ['an over-long name', ['x'.repeat(129)]],
  ])('rejects provide with %s', (_label, provide) => {
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [{ apiRange: '^4.0.0', export: 'main', provide }]),
    ).toThrow(/provide/)
  })

  it('declares optional injected services as a subset of inject', () => {
    const [entry] = parseAgnesPluginEntries('@acme/example', [
      { apiRange: '^4.0.0', export: 'main', inject: ['tools', 'clock'], optionalInject: ['clock'] },
    ])
    expect(entry?.optionalInject).toEqual(['clock'])
    expect(Object.isFrozen(entry?.optionalInject)).toBe(true)
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [
        { apiRange: '^4.0.0', export: 'main', inject: ['tools'], optionalInject: ['clock'] },
      ]),
    ).toThrow(/subset of inject/)
  })

  it('rejects an invalid inject list the same way', () => {
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [{ apiRange: '^4.0.0', export: 'main', inject: 'clock' }]),
    ).toThrow(/inject/)
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [
        { apiRange: '^4.0.0', export: 'main', inject: ['clock', 'clock'] },
      ]),
    ).toThrow(/duplicate/)
  })
})

it('accepts multiple declared package kinds, preserves absence and rejects unsupported or duplicate kinds', () => {
  expect(parseAgnesPluginProvides(undefined)).toBeUndefined()
  expect(parseAgnesPluginProvides(['tool', 'loop', 'model-adapter', 'mcp', 'skills', 'ui'])).toEqual([
    'tool',
    'loop',
    'model-adapter',
    'mcp',
    'skills',
    'ui',
  ])
  expect(Object.isFrozen(parseAgnesPluginProvides(['tool', 'ui']))).toBe(true)
  for (const input of [null, 'tool', ['tool', 'tool'], ['unknown'], [1]])
    expect(() => parseAgnesPluginProvides(input)).toThrow('agnes.provides')
})

it('validates explicit launch blocks without inheriting them and reports static preflight stages', () => {
  const launch = { title: { en: 'Work' }, description: { en: 'Work safely' }, preset: 'safe' }
  const bundles = {
    base: { presets: { safe: { name: 'safe' } }, launch },
    child: { extends: ['acme/kit#base'] },
  }
  const input = { packageId: 'acme/kit', bundles }
  expect(
    parsePackageBundleContract(input.packageId, bundles)['acme/kit#child']?.document.launch,
  ).toBeUndefined()
  expect(preflightPackageBundles({ ...input, stage: 'structural' }).level).toBe('structural')
  expect(preflightPackageBundles(input).level).toBe('static-references')
  expect(
    preflightPackageBundles({
      ...input,
      bundles: { base: { ...bundles.base, launch: { ...launch, preset: 'deployment' } } },
    }),
  ).toMatchObject({
    level: 'deployment-dependent',
    reasons: ['launch-preset-definition-required:deployment'],
    next: 'validate-deployment',
  })
  expect(preflightPackageBundles({ ...input, runtime: [{ runtime: 'in-process' }] }).level).toBe(
    'deployment-dependent',
  )
  for (const invalid of [
    { base: { ...bundles.base, launch: { ...launch, preset: undefined } } },
    { base: { extends: ['base'] } },
    { base: { extends: ['acme/kit#missing'] } },
    { base: { extends: ['acme/kit#base'] } },
    { base: { presets: { safe: { name: 'safe', invented: true } } } },
    { base: { ...bundles.base, launch: { ...launch, pages: ['undeclared'] } } },
    {
      base: {
        ...bundles.base,
        launch: { ...launch, prompt: { text: { en: 'secret://credential' }, mode: 'draft' } },
      },
    },
    {
      base: {
        ...bundles.base,
        launch: { ...launch, prompt: { text: { en: '😀'.repeat(4097) }, mode: 'draft' } },
      },
    },
  ])
    expect(preflightPackageBundles({ ...input, bundles: invalid }).level).toBe('refused')
  expect(preflightPackageBundles({ ...input, runtime: [{ runtime: 'isolated' }] }).level).toBe('refused')
  expect(
    preflightPackageBundles({
      ...input,
      bundles: { dependent: { extends: ['other/pkg#base'] } },
      dependencies: { 'other/pkg': '^1' },
    }).level,
  ).toBe('deployment-dependent')
  const dependency = parsePackageBundleContract('other/pkg', { base: bundles.base })
  for (const dependent of [
    { extends: ['other/pkg#base'] },
    { presets: { safe: { name: 'safe', bundles: ['other/pkg#base'] } } },
  ])
    expect(
      preflightPackageBundles({
        ...input,
        bundles: { dependent },
        catalog: dependency,
      }).level,
    ).toBe('refused')
  expect(
    preflightPackageBundles({
      ...input,
      bundles: { dependent: { extends: ['other/pkg#base'], launch } },
      catalog: dependency,
      dependencies: { 'other/pkg': '^1' },
    }).level,
  ).toBe('static-references')
})

it('checks effective preset inheritance after parent-to-child overrides and defers unknown chains', () => {
  const launch = { title: { en: 'Work' }, description: { en: 'Work' }, preset: 'a' }
  const input = { packageId: 'acme/kit' }
  for (const runtime of [undefined, [{ runtime: 'in-process' }]]) {
    for (const bundles of [
      {
        work: {
          presets: { a: { name: 'a', extends: 'b' }, b: { name: 'b', extends: 'a' } },
          launch,
        },
      },
      {
        parent: { presets: { a: { name: 'a', extends: 'b' }, b: { name: 'b' } } },
        work: {
          extends: ['acme/kit#parent'],
          // Omitting a.extends preserves the parent link; overriding b creates the cycle.
          presets: { a: { name: 'a' }, b: { name: 'b', extends: 'a' } },
          launch,
        },
      },
    ])
      expect(preflightPackageBundles({ ...input, bundles, ...(runtime ? { runtime } : {}) })).toMatchObject({
        level: 'refused',
        reasons: [expect.stringContaining('preset extends cycle')],
        next: 'fix-declaration',
      })
  }
  expect(
    preflightPackageBundles({
      ...input,
      bundles: { work: { presets: { a: { name: 'a', extends: 'deployment' } }, launch } },
    }),
  ).toMatchObject({
    level: 'deployment-dependent',
    reasons: ['preset-inheritance-definition-required:deployment'],
  })
  const catalog = parsePackageBundleContract('other/pkg', {
    common: { presets: { a: { name: 'a', extends: 'deployment' }, b: { name: 'b' } } },
    left: { extends: ['other/pkg#common'], presets: { a: { name: 'a', extends: 'b' } } },
    right: { extends: ['other/pkg#common'] },
  })
  expect(
    preflightPackageBundles({
      ...input,
      catalog,
      dependencies: { 'other/pkg': '^1' },
      bundles: { work: { extends: ['other/pkg#left', 'other/pkg#right'], launch } },
    }).level,
  ).toBe('static-references')
  expect(
    preflightPackageBundles({
      ...input,
      catalog,
      dependencies: { 'other/pkg': '^1' },
      bundles: { work: { extends: ['other/pkg#missing'], presets: { a: { name: 'a' } }, launch } },
    }),
  ).toMatchObject({
    level: 'deployment-dependent',
    reasons: expect.arrayContaining(['preset-inheritance-definition-required:a']),
  })
  const cycle = { a: { name: 'a', extends: 'b' }, b: { name: 'b', extends: 'a' } }
  const cyclicParent = parsePackageBundleContract('other/pkg', { base: { presets: cycle } })
  // A child can repair an inherited cycle; checking raw parents before their overrides is wrong.
  expect(
    preflightPackageBundles({
      ...input,
      catalog: cyclicParent,
      dependencies: { 'other/pkg': '^1' },
      bundles: {
        work: {
          extends: ['other/pkg#base'],
          presets: { b: { name: 'b', extends: 'c' }, c: { name: 'c' } },
          launch,
        },
      },
    }).level,
  ).toBe('static-references')
  // An unknown later parent might repair the cycle, but explicit later edges prove it again.
  for (const [presets, level] of [
    [{}, 'deployment-dependent'],
    [cycle, 'refused'],
  ] as const)
    expect(
      preflightPackageBundles({
        ...input,
        catalog: cyclicParent,
        dependencies: { 'other/pkg': '^1' },
        bundles: { work: { extends: ['other/pkg#base', 'other/pkg#missing'], presets, launch } },
      }).level,
    ).toBe(level)
})

it('validates application identity and explicit agent, page and role references', () => {
  const bundles = parsePackageBundleContract('acme/kit', {
    work: {
      launch: { title: { en: 'Work' }, description: { en: 'Work' }, preset: 'safe' },
      presets: { safe: { name: 'safe' } },
    },
  })
  const app = { id: 'acme', defaultAgent: 'acme/kit#work', agents: ['acme/kit#work'] }
  expect(parseApplicationContract(app, 'acme/kit', bundles, {}).application).toEqual(app)
  expect(
    parseApplicationContract({ ...app, delegableAgents: app.agents }, 'acme/kit', bundles, {}).application
      ?.delegableAgents,
  ).toEqual(app.agents)
  const many = parsePackageBundleContract(
    'acme/kit',
    Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `role${index}`,
        {
          launch: { title: { en: `Role ${index}` }, description: { en: 'Role' }, preset: 'safe' },
          presets: { safe: { name: 'safe' } },
        },
      ]),
    ),
  )
  const manyRefs = Array.from({ length: 9 }, (_, index) => `acme/kit#role${index}`)
  expect(
    parseApplicationContract(
      { id: 'acme', agents: manyRefs, delegableAgents: manyRefs.slice(0, 8) },
      'acme/kit',
      many,
      {},
    ).application?.delegableAgents,
  ).toHaveLength(8)
  expect(() =>
    parseApplicationContract(
      { id: 'acme', agents: manyRefs, delegableAgents: manyRefs },
      'acme/kit',
      many,
      {},
    ),
  ).toThrow()
  const workbench = {
    tabs: [
      {
        id: 'signatures',
        title: { en: 'Signatures', 'zh-CN': '待签署' },
        order: 0,
        slot: 'workbench.panel',
        view: 'signatures',
      },
    ],
    actions: [
      {
        id: 'review',
        title: { en: 'Review' },
        prompt: { en: 'Review this NCR' },
        focusTab: 'signatures',
        object: { type: 'ncr', id: 'NCR-018' },
      },
    ],
  }
  expect(
    parseApplicationContract({ ...app, workbench }, 'acme/kit', bundles, {}).application?.workbench,
  ).toEqual(workbench)
  expect(() =>
    parseApplicationContract(
      { ...app, workbench: { ...workbench, actions: [...workbench.actions, ...workbench.actions] } },
      'acme/kit',
      bundles,
      {},
    ),
  ).toThrow()
  for (const tabs of [
    [...workbench.tabs, ...workbench.tabs],
    Array.from({ length: 9 }, (_, index) => ({ ...workbench.tabs[0], id: `tab${index}` })),
    [{ ...workbench.tabs[0], order: 101 }],
    [{ ...workbench.tabs[0], when: 'arbitrary-code' }],
    [{ ...workbench.tabs[0], title: { en: 'x'.repeat(2049) } }],
  ])
    expect(() =>
      parseApplicationContract({ ...app, workbench: { ...workbench, tabs } }, 'acme/kit', bundles, {}),
    ).toThrow()

  for (const value of [
    { ...app, brand: { unknown: 'no' } },
    { ...app, presentation: { roles: { unknown: { packageId: 'acme/kit', clientId: 'ui' } } } },
    { ...app, presentation: { roles: { navigation: { packageId: 'acme/kit', clientId: 'ui' } } } },
    { ...app, presentation: { home: 'acme/kit#unknown' } },
    { ...app, defaultAgent: 'acme/kit#missing' },
    { ...app, agents: [] },
    { ...app, delegableAgents: ['acme/kit#missing'] },
    { ...app, agents: undefined, delegableAgents: app.agents },
    { ...app, delegableAgents: Array(9).fill('acme/kit#work') },
    { ...app, delegableAgents: [...app.agents, ...app.agents] },
    {
      ...app,
      workbench: {
        tabs: [{ id: 'object', title: { en: 'Object' }, order: 0, slot: 'unknown', view: 'signatures' }],
      },
    },
    {
      ...app,
      workbench: {
        tabs: [{ id: 'object', title: { en: 'Object' }, order: 0, slot: 'workbench.panel', view: 'page' }],
      },
    },
    {
      ...app,
      workbench: {
        actions: [{ id: 'work', title: { en: 'Work' }, prompt: { en: 'Review' }, agent: 'acme/kit#missing' }],
      },
    },
    {
      ...app,
      workbench: {
        actions: [{ id: 'work', title: { en: 'Work' }, prompt: { en: 'Review' }, focusTab: 'missing' }],
      },
    },
    {
      ...app,
      workbench: {
        actions: Array.from({ length: 13 }, (_, i) => ({
          id: `work${i}`,
          title: { en: 'Work' },
          prompt: { en: 'Review' },
        })),
      },
    },
    {
      ...app,
      workbench: {
        actions: [
          {
            id: 'work',
            title: { en: 'Work' },
            prompt: { en: 'Review' },
            object: { type: 'ncr', id: 'x'.repeat(129) },
          },
        ],
      },
    },
  ])
    expect(() => parseApplicationContract(value, 'acme/kit', bundles, {})).toThrow()
  expect(
    parseApplicationContract({ id: 'acme', agents: ['other/pkg#work'] }, 'acme/kit', bundles, {
      'other/pkg': '^1',
    }).deploymentDependent,
  ).toBe(true)
})

it('resolves local application home/navigation and only statically declared profile roles', () => {
  const client = {
    kind: 'client' as const,
    id: 'ui-row',
    rowId: 'ext:acme/ui',
    path: './client.json',
    client: {
      id: 'ui',
      entry: './ui.js',
      lifetime: 'profile' as const,
      homeEntries: [{ id: 'home.details', placement: 'primary' as const }],
      presentationRoles: ['navigation' as const],
    },
  }
  const app = {
    id: 'acme',
    brand: { name: { en: 'Acme' } },
    presentation: {
      home: 'acme/kit#home.details',
      navigation: { entries: ['acme/kit#home.details'] },
      roles: { navigation: { packageId: 'acme/kit', clientId: 'ui' } },
    },
  }
  expect(parseApplicationContract(app, 'acme/kit', {}, {}, [client])).toMatchObject({
    application: app,
    deploymentDependent: false,
  })
  for (const contribution of [
    { ...client, client: { ...client.client, presentationRoles: [] } },
    { ...client, client: { ...client.client, lifetime: 'session' as const } },
  ])
    expect(() => parseApplicationContract(app, 'acme/kit', {}, {}, [contribution])).toThrow()
})
