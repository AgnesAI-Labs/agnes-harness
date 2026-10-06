import { readFileSync } from 'node:fs'
import {
  type ClientCatalogPageRequest,
  type ClientQueryRequest,
  type DomainQuery,
  type DomainView,
  RuntimeClientTransportWire,
  type RuntimeWireTypes,
  type ViewAction,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  createRuntimeClient,
  encodeForChannel,
  formatDomainView,
  RuntimeClientTransport,
  type RuntimeFetch,
} from '@agnes/sdk/runtime'
import { describe, expect, it } from 'vitest'
import { memoryJournal } from '../../src/journal.js'

// The client package a plugin author outside this repository ships, as the Web client's test reads it
// (web-client/test/runtime/fixtures/author-client): its catalog entry, a selection of it and a view it
// renders. The SDK runs no author code, so it reads the catalog entry from the server's catalog, reads
// the view through the domain client and presents it with the default text formatter. Each fixture is
// checked against the wire schema first, so every refusal below is the SDK's own.
const FIXTURE = new URL('../../../web-client/test/runtime/fixtures/author-client/', import.meta.url)
function wire<K extends keyof RuntimeWireTypes>(name: K, file: string): RuntimeWireTypes[K] {
  const checked = validateRuntime(name, JSON.parse(readFileSync(new URL(file, FIXTURE), 'utf8')))
  if (!checked.ok) throw new Error(`not a valid ${name}: ${JSON.stringify(checked.errors)}`)
  return checked.value
}

const MODULE = wire('ClientModule', 'client-module.json')
const WEB_SELECTION = wire('ClientSelection', 'selection.json')
const VIEW = wire('DomainView', 'view.json')
const NOTE = VIEW.viewSchema
const NEXT = 'd'.repeat(64)
/** The same selection as an SDK client receives it: no shell, the note card for the sdk target. */
const SELECTION = {
  ...WEB_SELECTION,
  target: 'sdk' as const,
  shell: null,
  rendererSelections: WEB_SELECTION.rendererSelections.map((row) => ({ ...row, target: 'sdk' as const })),
}
const SHARE: ViewAction = {
  kind: 'command',
  actionKey: 'share',
  label: 'Share',
  requiredFeatures: ['acme.notes/share'],
  availability: 'enabled',
  disabledReason: null,
  command: 'share',
  inputSchema: { typeId: 'acme.notes/share@1', revision: 1, digest: 'e'.repeat(64) },
}
const QUERY: DomainQuery = {
  domainType: VIEW.domainType,
  query: {
    kind: 'inline',
    schema: { typeId: 'acme.notes/notes-query@1', revision: 1, digest: 'f'.repeat(64) },
    value: {},
    digest: 'f'.repeat(64),
    bytes: 2,
  },
  scope: VIEW.scope,
  cursor: null,
  limit: 10,
}

const { routes } = RuntimeClientTransportWire
type Page = { modules: unknown[]; domainSchemas: unknown[] }
/** The catalog as the server issues it: the welcome carries the first page, which the second repeats. */
const CATALOG: readonly Page[] = [
  { modules: [MODULE], domainSchemas: [NOTE] },
  { modules: [MODULE], domainSchemas: [NOTE] },
]

const capabilities = (features: readonly string[]) => ({
  clientInstanceId: 'client-1',
  target: 'sdk' as const,
  protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
  viewSchemaRanges: [],
  renderKeys: [],
  features: [RuntimeClientTransportWire.feature, ...features],
  capabilitiesRevision: 1,
  interaction: { text: true, singleChoice: true, multiChoice: true, confirm: true, complexFormLink: false },
  files: { link: true, upload: false, maxUploadBytes: 0, allowedMimes: [] },
  display: { plainText: true, markdown: true, maxTextBytes: 4096, inlinePreviewMimes: [] },
})

type Server = { catalog?: readonly Page[]; features?: readonly string[]; views?: unknown[] }

/** An in-process server for the runtime client wire: bootstrap, catalog pages and domain queries. */
function serve({ catalog = CATALOG, features = [], views = [VIEW] }: Server): RuntimeFetch {
  const page = (index: number) => ({
    ...catalog[index],
    nextCursor: index + 1 < catalog.length ? String(index + 1) : null,
    complete: index + 1 >= catalog.length,
  })
  const answer = (path: string, body: unknown): unknown => {
    if (path === routes.bootstrap.path) {
      const { nextCursor, complete, ...first } = page(0)
      const welcome = {
        negotiatedSession: 'session-1',
        wireVersion: { major: 2, minor: 0 },
        catalogRevision: 1,
        capabilities: {
          ...capabilities(features),
          negotiatedSession: 'session-1',
          effectivePolicyRevision: 1,
        },
        ...first,
        mode: 'compatible',
        reasons: [],
        clientInstanceId: 'client-1',
        clientSelection: SELECTION,
      }
      return { welcome, catalogPage: { nextCursor, complete } }
    }
    if (path === routes.catalogPage.path) {
      const { cursor } = body as ClientCatalogPageRequest
      return { catalogRevision: 1, ...page(Number(cursor)) }
    }
    if (path === routes.clientQuery.path) {
      const { header, call } = body as ClientQueryRequest
      const snapshot = {
        items: views,
        cursor: 'c1',
        projectionRevision: 1,
        nextPageCursor: null,
        complete: true,
      }
      return { header, reply: { operation: call.operation, value: snapshot } }
    }
    throw new Error(`unexpected route ${path}`)
  }
  return async (url, init) =>
    new Response(
      JSON.stringify({ ok: true, value: answer(new URL(url).pathname, JSON.parse(String(init.body))) }),
      {
        status: 200,
      },
    )
}

function connectTo(server: Server = {}) {
  const transport = new RuntimeClientTransport({
    baseUrl: 'http://agh.test',
    hello: { capabilities: capabilities(server.features ?? []), authorApi: [], loadedBundles: [] },
    journal: memoryJournal(),
    fetch: serve(server),
  })
  return { transport, client: createRuntimeClient(transport) }
}

/** The view the domain client reads, formatted for the capabilities this client negotiated. */
async function readAndFormat(server: Server) {
  const { transport, client } = connectTo(server)
  await transport.connect()
  const read = await client.domain.query(QUERY)
  if (read.state !== 'ok') throw new Error(`the domain query was not answered: ${JSON.stringify(read)}`)
  const [view] = read.value.items
  if (view === undefined) throw new Error('the snapshot holds no view')
  const negotiated = transport.capabilities
  if (negotiated === null) throw new Error('no negotiated capabilities')
  const formatted = formatDomainView(view, { locale: 'en', capabilities: negotiated })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return { view, formatted: formatted.value }
}

const chat = { kind: 'test-chat', maxTextBytes: 4096, supportsButtons: true }
const offered = (parts: { kind: string; actionKey?: string }[]) =>
  parts.flatMap((part) => (part.kind === 'action' ? [part.actionKey] : []))

describe('an outside author client package read by the SDK', () => {
  it('reads its catalog entry and selection from the server catalog', async () => {
    const { transport } = connectTo()
    await transport.connect()
    expect(transport.catalog).toEqual({ complete: true, modules: [MODULE], domainSchemas: [NOTE] })
    expect(transport.clientSelection).toEqual(SELECTION)
  })

  // The text a Web client shows for this view in the generic card, so every client says the same.
  it('reads its view through the domain client and formats it as text', async () => {
    const { view, formatted } = await readAndFormat({})
    expect(view).toEqual(VIEW)
    expect(formatted).toEqual({
      viewId: 'note-1',
      revision: 1,
      parts: [
        { kind: 'text', text: 'Status: Final' },
        { kind: 'text', text: 'Note: Release checklist' },
      ],
      complete: true,
      unsupportedRequiredFeatures: [],
    })
    expect(encodeForChannel(formatted, chat)).toEqual({
      ok: true,
      value: {
        messages: [
          { text: 'Status: Final\nNote: Release checklist', actionKeys: [], partIndex: 0, partCount: 1 },
        ],
        complete: true,
        requiresWebForm: false,
      },
    })
  })

  it.each([
    {
      name: 'is not negotiated',
      features: [],
      keys: [],
      last: { kind: 'text', text: 'Share: Not available here.' },
      complete: false,
      unsupported: ['acme.notes/share'],
    },
    {
      name: 'is negotiated',
      features: ['acme.notes/share'],
      keys: ['share'],
      last: { kind: 'action', actionKey: 'share', label: 'Share' },
      complete: true,
      unsupported: [],
    },
  ])('offers an action only when the feature it requires $name', async (row) => {
    const { formatted } = await readAndFormat({
      features: row.features,
      views: [{ ...VIEW, actions: [SHARE] }],
    })
    expect(offered(formatted.parts)).toEqual(row.keys)
    expect(formatted.parts.at(-1)).toEqual(row.last)
    expect(formatted).toMatchObject({ complete: row.complete, unsupportedRequiredFeatures: row.unsupported })
    const sent = encodeForChannel(formatted, chat)
    expect(sent).toMatchObject({
      ok: true,
      value: { complete: row.complete, requiresWebForm: !row.complete },
    })
    expect(sent.ok && sent.value.messages.flatMap((message) => message.actionKeys)).toEqual(row.keys)
  })

  const second = (page: Partial<Page>): Page[] => [CATALOG[0] as Page, { ...CATALOG[1], ...page } as Page]
  it.each<{ name: string; catalog: Page[]; message: string }>([
    {
      name: 'its catalog entry locks the note schema under another digest than the catalog',
      catalog: [{ modules: [{ ...MODULE, schemas: [{ ...NOTE, digest: NEXT }] }], domainSchemas: [NOTE] }],
      message: 'invalid bootstrap reply',
    },
    {
      name: 'a later page names the note schema under another digest',
      catalog: second({ domainSchemas: [{ ...NOTE, digest: NEXT }] }),
      message: 'conflicting catalog entries',
    },
    {
      name: 'a later page names its module under another package digest',
      catalog: second({ modules: [{ ...MODULE, packageDigest: NEXT }] }),
      message: 'conflicting catalog entries',
    },
    {
      name: 'a later page names its module under another asset digest',
      catalog: second({ modules: [{ ...MODULE, assetDigest: NEXT }] }),
      message: 'conflicting catalog entries',
    },
    {
      name: 'a later page names its module with another required feature',
      catalog: second({ modules: [{ ...MODULE, requiredFeatures: ['acme.notes/share'] }] }),
      message: 'conflicting catalog entries',
    },
  ])('refuses the catalog when $name', async ({ catalog, message }) => {
    const { transport } = connectTo({ catalog })
    await expect(transport.connect()).rejects.toThrow(message)
    // A command leaves the client only while the catalog is complete.
    expect(transport.catalog?.complete ?? false).toBe(false)
  })

  it.each<[string, DomainView]>([
    ['its schema digest is not a digest', { ...VIEW, viewSchema: { ...NOTE, digest: 'not-a-digest' } }],
    ['its phase is unknown', { ...VIEW, phase: 'paused' } as unknown as DomainView],
  ])('does not return a view when %s', async (_name, view) => {
    const { transport, client } = connectTo({ views: [view] })
    await transport.connect()
    expect(await client.domain.query(QUERY)).toMatchObject({ state: 'unknown' })
  })
})
