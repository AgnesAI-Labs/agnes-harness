import type { ClientModule, RendererDescriptor } from '@agnes/extension-api/client'
import { describe, expect, it } from 'vitest'
import {
  type ClientModuleContribution,
  type ClientSelection,
  type ClientTarget,
  resolveClientSelection,
} from '../../src/runtime/client-selection.js'

/** Stands for the entry of the module a renderer is declared in, filled in when the module is made. */
const OWN_ENTRY = './own-entry.js'

/** A module factory for one package generation; its renderers declare the module's entry unless a case says otherwise. */
const generation =
  (packageId: string, digit: string) =>
  (moduleId: string, targets: ClientModule['targets'], contributions?: ClientModuleContribution[]) => {
    const entryPath = `./${moduleId.replaceAll('/', '-')}.js`
    const own = (entry: ClientModuleContribution): ClientModuleContribution =>
      entry.kind === 'renderer' && entry.descriptor?.entry === OWN_ENTRY
        ? { ...entry, descriptor: { ...entry.descriptor, entry: entryPath } }
        : entry
    return {
      moduleId,
      packageId,
      packageDigest: digit.repeat(64),
      assetDigest: 'e'.repeat(64),
      entryPath,
      ownerToken: `${packageId}-owner`,
      authorApiMajor: 1,
      targets,
      schemas: [],
      requiredFeatures: [],
      styles: [],
      ...(contributions ? { contributions: contributions.map(own) } : {}),
    } satisfies ClientModule
  }

const client = generation('acme.client', '1')
const notes = generation('acme.notes', '2')
const code = generation('acme.code', '3')

const renderer = (
  contributionId: string,
  renderKey: string,
  targets: ClientModule['targets'],
  packageDigit: string,
  descriptor: Partial<RendererDescriptor> = {},
): ClientModuleContribution => ({
  contributionId,
  kind: 'renderer',
  targets,
  descriptor: {
    id: contributionId,
    packageDigest: packageDigit.repeat(64),
    renderKey,
    targets,
    viewSchemaRanges: [{ typeId: 'acme/view@1', minRevision: 1, maxRevision: 1 }],
    requiredFeatures: [],
    optionalFeatures: [],
    scope: 'view',
    entry: OWN_ENTRY,
    ...descriptor,
  },
})

const webContributions: ClientModuleContribution[] = [
  { contributionId: 'workbench', kind: 'shell', export: 'workbenchShell', targets: ['web'] },
  { contributionId: 'registry', kind: 'registry', export: 'createRegistry', targets: ['web'] },
  renderer('fallback', 'acme.client/fallback', ['web'], '1'),
]
const webModule = client('acme.client/web', ['web'], webContributions)
const tuiModule = client(
  'acme.client/tui',
  ['tui'],
  [
    { contributionId: 'tui-registry', kind: 'registry', export: 'createTuiRegistry', targets: ['tui'] },
    renderer('tui-fallback', 'acme.client/fallback', ['tui'], '1'),
  ],
)
const notesModule = notes(
  'acme.notes/cards',
  ['web', 'tui'],
  [renderer('note-card', 'acme.notes/card', ['web', 'tui'], '2')],
)
const codeModule = code(
  'acme.code/blocks',
  ['web'],
  [renderer('code-block', 'acme.code/block', ['web'], '3')],
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
/** A selected renderer, with the descriptor its catalog contribution declares. */
const drawn = (module: ClientModule, contributionId: string) => {
  const found = module.contributions?.find((entry) => entry.contributionId === contributionId)
  return {
    ...chosen(module, contributionId),
    descriptor: found?.kind === 'renderer' ? found.descriptor : undefined,
  }
}
const swap = (module: ClientModule) =>
  catalog.map((entry) => (entry.moduleId === module.moduleId ? module : entry))
/** The catalog with the code block renderer declaring `descriptor` over its own. */
const blocks = (descriptor: Partial<RendererDescriptor>) =>
  swap(
    code('acme.code/blocks', ['web'], [renderer('code-block', 'acme.code/block', ['web'], '3', descriptor)]),
  )

describe('resolveClientSelection', () => {
  it('refuses a welcome without a selection instead of keeping an older module path', () => {
    expect(resolveClientSelection({ target: 'web', selection: undefined, modules: catalog })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'incompatible', detailCode: 'client_selection_absent' }),
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
        fallbackRenderer: drawn(webModule, 'fallback'),
        renderers: [
          { renderKey: 'acme.notes/card', renderer: drawn(notesModule, 'note-card') },
          { renderKey: 'acme.code/block', renderer: drawn(codeModule, 'code-block') },
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
        renderer('fallback', 'acme.client/fallback', ['tui'], '1'),
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
        fallbackRenderer: drawn(tuiModule, 'tui-fallback'),
        renderers: [{ renderKey: 'acme.notes/card', renderer: drawn(notesModule, 'note-card') }],
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
          [...webContributions.slice(0, 2), renderer('fallback', 'acme.client/fallback', ['tui'], '1')],
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
        code('acme.code/notes', ['web'], [renderer('note-card', 'acme.notes/card', ['web'], '3')]),
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
    {
      name: 'a renderer contribution without a descriptor',
      modules: swap(
        code(
          'acme.code/blocks',
          ['web'],
          [{ contributionId: 'code-block', kind: 'renderer', targets: ['web'] } as ClientModuleContribution],
        ),
      ),
      detailCode: 'client_selection_descriptor',
    },
    {
      name: 'a fallback renderer descriptor for another id',
      modules: swap(
        client(
          'acme.client/web',
          ['web'],
          [
            ...webContributions.slice(0, 2),
            renderer('fallback', 'acme.client/fallback', ['web'], '1', { id: 'other-fallback' }),
          ],
        ),
      ),
      detailCode: 'client_selection_descriptor',
    },
    {
      name: 'a renderer descriptor for another id',
      modules: blocks({ id: 'other-block' }),
      detailCode: 'client_selection_descriptor',
    },
    {
      name: 'a renderer descriptor of another package generation',
      modules: blocks({ packageDigest: '9'.repeat(64) }),
      detailCode: 'client_selection_descriptor',
    },
    {
      name: 'a renderer descriptor for other targets than its contribution',
      modules: blocks({ targets: ['web', 'tui'] }),
      detailCode: 'client_selection_descriptor',
    },
    {
      name: 'a renderer descriptor for another render key than its row',
      modules: blocks({ renderKey: 'acme.code/other' }),
      detailCode: 'client_selection_descriptor',
    },
    {
      name: 'a renderer descriptor naming an entry its module does not load',
      modules: blocks({ entry: './elsewhere.js' }),
      detailCode: 'client_selection_entry',
    },
    {
      name: 'a fallback renderer descriptor naming another module entry',
      modules: swap(
        client(
          'acme.client/web',
          ['web'],
          [
            ...webContributions.slice(0, 2),
            renderer('fallback', 'acme.client/fallback', ['web'], '1', { entry: './acme.code-blocks.js' }),
          ],
        ),
      ),
      detailCode: 'client_selection_entry',
    },
  ]

  it.each(refusals)('refuses $name', ({ target = 'web', selection = web, modules = catalog, detailCode }) => {
    expect(resolveClientSelection({ target, selection, modules })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'incompatible', detailCode, retryAdvice: { kind: 'never' } }),
    })
  })
})
