import type { ClientModule } from '@agnes/extension-api/client'
import { describe, expect, it } from 'vitest'
import {
  type ClientModuleContribution,
  type ClientSelection,
  type ClientTarget,
  resolveClientSelection,
} from '../../src/runtime/client-selection.js'

/** A module factory for one package generation. */
const generation =
  (packageId: string, digit: string) =>
  (moduleId: string, targets: ClientModule['targets'], contributions?: ClientModuleContribution[]) =>
    ({
      moduleId,
      packageId,
      packageDigest: digit.repeat(64),
      assetDigest: 'e'.repeat(64),
      entryPath: `./${moduleId.replaceAll('/', '-')}.js`,
      ownerToken: `${packageId}-owner`,
      authorApiMajor: 1,
      targets,
      schemas: [],
      requiredFeatures: [],
      styles: [],
      ...(contributions ? { contributions } : {}),
    }) satisfies ClientModule

const client = generation('acme.client', '1')
const notes = generation('acme.notes', '2')
const code = generation('acme.code', '3')

const webContributions: ClientModuleContribution[] = [
  { contributionId: 'workbench', kind: 'shell', export: 'workbenchShell', targets: ['web'] },
  { contributionId: 'registry', kind: 'registry', export: 'createRegistry', targets: ['web'] },
  { contributionId: 'fallback', kind: 'renderer', targets: ['web'] },
]
const webModule = client('acme.client/web', ['web'], webContributions)
const tuiModule = client(
  'acme.client/tui',
  ['tui'],
  [
    { contributionId: 'tui-registry', kind: 'registry', export: 'createTuiRegistry', targets: ['tui'] },
    { contributionId: 'tui-fallback', kind: 'renderer', targets: ['tui'] },
  ],
)
const notesModule = notes(
  'acme.notes/cards',
  ['web', 'tui'],
  [{ contributionId: 'note-card', kind: 'renderer', targets: ['web', 'tui'] }],
)
const codeModule = code(
  'acme.code/blocks',
  ['web'],
  [{ contributionId: 'code-block', kind: 'renderer', targets: ['web'] }],
)
const catalog: ClientModule[] = [webModule, tuiModule, notesModule, codeModule]

const web: ClientSelection = {
  target: 'web',
  shell: { packageId: 'acme.client', contributionId: 'workbench' },
  registry: { packageId: 'acme.client', contributionId: 'registry' },
  fallbackRenderer: { packageId: 'acme.client', contributionId: 'fallback' },
  rendererSelections: [
    { renderKey: 'acme.notes/card', rendererId: 'note-card', target: 'web' },
    { renderKey: 'acme.code/block', rendererId: 'code-block', target: 'web' },
  ],
}
const tui: ClientSelection = {
  target: 'tui',
  shell: null,
  registry: { packageId: 'acme.client', contributionId: 'tui-registry' },
  fallbackRenderer: { packageId: 'acme.client', contributionId: 'tui-fallback' },
  rendererSelections: [{ renderKey: 'acme.notes/card', rendererId: 'note-card', target: 'tui' }],
}

const chosen = (module: ClientModule, contributionId: string) => ({
  moduleId: module.moduleId,
  packageId: module.packageId,
  packageDigest: module.packageDigest,
  entryPath: module.entryPath,
  contributionId,
})
const swap = (module: ClientModule) =>
  catalog.map((entry) => (entry.moduleId === module.moduleId ? module : entry))

describe('resolveClientSelection', () => {
  it('keeps the legacy path for a welcome without a selection', () => {
    expect(resolveClientSelection({ target: 'web', selection: undefined, modules: catalog })).toEqual({
      ok: true,
      value: { kind: 'legacy' },
    })
  })

  it('selects one module per contribution for a web client, in row order', () => {
    expect(resolveClientSelection({ target: 'web', selection: web, modules: catalog })).toEqual({
      ok: true,
      value: {
        kind: 'selected',
        target: 'web',
        shell: { ...chosen(webModule, 'workbench'), export: 'workbenchShell' },
        registry: { ...chosen(webModule, 'registry'), export: 'createRegistry' },
        fallbackRenderer: chosen(webModule, 'fallback'),
        renderers: [
          { renderKey: 'acme.notes/card', renderer: chosen(notesModule, 'note-card') },
          { renderKey: 'acme.code/block', renderer: chosen(codeModule, 'code-block') },
        ],
      },
    })
  })

  it('takes the bundle that serves the target when bundles for other targets declare the same id', () => {
    const other = client(
      'acme.client/tui-copy',
      ['tui'],
      [
        { contributionId: 'registry', kind: 'registry', export: 'createRegistry', targets: ['tui'] },
        { contributionId: 'fallback', kind: 'renderer', targets: ['tui'] },
      ],
    )
    const found = resolveClientSelection({ target: 'web', selection: web, modules: [...catalog, other] })
    expect(found).toMatchObject({
      ok: true,
      value: { registry: { ...chosen(webModule, 'registry'), export: 'createRegistry' } },
    })
  })

  it('selects a tui client without a shell', () => {
    expect(resolveClientSelection({ target: 'tui', selection: tui, modules: catalog })).toEqual({
      ok: true,
      value: {
        kind: 'selected',
        target: 'tui',
        shell: null,
        registry: { ...chosen(tuiModule, 'tui-registry'), export: 'createTuiRegistry' },
        fallbackRenderer: chosen(tuiModule, 'tui-fallback'),
        renderers: [{ renderKey: 'acme.notes/card', renderer: chosen(notesModule, 'note-card') }],
      },
    })
  })

  const rows = web.rendererSelections
  const refusals: Array<{
    name: string
    target?: ClientTarget
    selection?: ClientSelection
    modules?: ClientModule[]
    detailCode: string
  }> = [
    { name: 'a selection for another target', target: 'tui', detailCode: 'client_selection_target' },
    {
      name: 'a renderer row for another target',
      selection: {
        ...web,
        rendererSelections: [
          ...rows,
          { renderKey: 'acme.notes/plain', rendererId: 'note-card', target: 'tui' },
        ],
      },
      detailCode: 'client_selection_target',
    },
    {
      name: 'a contribution that does not serve the target',
      modules: swap(
        client(
          'acme.client/web',
          ['web'],
          [
            ...webContributions.slice(0, 2),
            { contributionId: 'fallback', kind: 'renderer', targets: ['tui'] },
          ],
        ),
      ),
      detailCode: 'client_selection_target',
    },
    {
      name: 'a module that does not serve the target',
      modules: swap({ ...webModule, targets: ['tui'] }),
      detailCode: 'client_selection_target',
    },
    {
      name: 'an unknown contribution id',
      selection: { ...web, registry: { packageId: 'acme.client', contributionId: 'missing' } },
      detailCode: 'client_selection_missing',
    },
    {
      name: 'a contribution of another kind',
      selection: { ...web, fallbackRenderer: { packageId: 'acme.client', contributionId: 'registry' } },
      detailCode: 'client_selection_missing',
    },
    {
      name: 'a module that omits its contributions',
      modules: swap(client('acme.client/web', ['web'])),
      detailCode: 'client_selection_missing',
    },
    {
      name: 'a renderer whose module does not serve the target',
      modules: swap({ ...codeModule, targets: ['tui'] }),
      detailCode: 'client_selection_target',
    },
    {
      name: 'one contribution declared by two modules of a package',
      modules: [...catalog, client('acme.client/web-copy', ['web'], webContributions)],
      detailCode: 'client_selection_ambiguous',
    },
    {
      name: 'one renderer id declared by two packages',
      modules: [
        ...catalog,
        code(
          'acme.code/notes',
          ['web'],
          [{ contributionId: 'note-card', kind: 'renderer', targets: ['web'] }],
        ),
      ],
      detailCode: 'client_selection_ambiguous',
    },
    {
      name: 'a render key selected twice',
      selection: {
        ...web,
        rendererSelections: [
          ...rows,
          { renderKey: 'acme.notes/card', rendererId: 'code-block', target: 'web' },
        ],
      },
      detailCode: 'client_selection_ambiguous',
    },
    {
      name: 'two generations of a selected package',
      modules: [...catalog, generation('acme.client', '9')('acme.client/stale', ['web'])],
      detailCode: 'client_selection_digest',
    },
    {
      name: 'two generations of a renderer package',
      modules: [...catalog, generation('acme.notes', '9')('acme.notes/stale', ['web'])],
      detailCode: 'client_selection_digest',
    },
  ]

  it.each(refusals)('refuses $name', ({ target = 'web', selection = web, modules = catalog, detailCode }) => {
    expect(resolveClientSelection({ target, selection, modules })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'incompatible', detailCode, retryAdvice: { kind: 'never' } }),
    })
  })
})
