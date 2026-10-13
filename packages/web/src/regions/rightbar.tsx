import {
  type ClientDocumentArtifact,
  ClientResourceReclaimedError,
  type ClientResourceService,
  dshSlotSpec,
  type LocaleService,
  type SessionService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import type { DocumentPreviewInput, DocumentPreviewKind } from '@agnes/web-conversation/document-preview'
import { createRegionRenderer, EmptyState, Icon } from '@agnes/web-ui'
import { DocumentPreview } from '@agnes/web-ui/conversation'
import { useLayoutEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  type EmptyStateRegionMount,
  RIGHTBAR_DOCUMENT_CHILDREN,
  RIGHTBAR_GUIDE_CHILDREN,
  RIGHTBAR_SESSION_CHILDREN,
} from './contracts.js'
export interface RightbarRegionOptions {
  session?: SessionService
  resources?: ClientResourceService
  document?: RightbarDocument
}
export interface RightbarRegionMount extends EmptyStateRegionMount {}
export interface RightbarDocument {
  readonly id: string
  readonly title?: string
  readonly kind: DocumentPreviewKind
  readonly content?: string
  readonly resourceUrl?: string
  readonly laneId?: string
  readonly artifact?: ClientDocumentArtifact
}
export function documentPreviewInput(
  document: RightbarDocument | undefined,
  t: (key: string) => string = (key) => key,
): DocumentPreviewInput {
  return {
    kind: document?.kind ?? 'text',
    title: document?.title ?? t('app.doc.previewTitle'),
    content: document?.content ?? '',
    ...(document?.resourceUrl === undefined ? {} : { resourceUrl: document.resourceUrl }),
  }
}
export function DocumentPreviewBuiltin({
  document,
  resources,
  t = (key) => key,
}: {
  document: RightbarDocument | undefined
  resources?: ClientResourceService
  t?: (key: string) => string
}): JSX.Element {
  const artifact = document?.artifact
  const laneId = document?.laneId
  const kind = document?.kind ?? 'text'
  const request = useMemo(
    () => (artifact && laneId ? { artifact, laneId, kind } : undefined),
    [artifact, laneId, kind],
  )
  const [loaded, setLoaded] = useState<{
    request: NonNullable<typeof request>
    resources: ClientResourceService
    input: DocumentPreviewInput
  }>()
  useLayoutEffect(() => {
    setLoaded(undefined)
    if (!request || !resources) return
    let active = true
    let resource: Awaited<ReturnType<ClientResourceService['documents']['load']>> | undefined
    void resources.documents
      .load(request)
      .then((value) => {
        if (!active) {
          value.release()
          return
        }
        resource = value
        setLoaded({
          request,
          resources,
          input: {
            kind: request.kind,
            ...(value.content === undefined ? {} : { content: value.content }),
            ...(value.url === undefined ? {} : { resourceUrl: value.url }),
          },
        })
      })
      .catch((error: unknown) => {
        if (!active) return
        setLoaded({
          request,
          resources,
          input: {
            kind: 'text',
            content:
              error instanceof ClientResourceReclaimedError
                ? t('app.doc.reclaimed')
                : t('app.doc.unavailable'),
          },
        })
      })
    return () => {
      active = false
      resource?.release()
    }
  }, [request, resources, t])
  // A changed owner must never paint the previous resource while its replacement is loading.
  const input =
    loaded && loaded.request === request && loaded.resources === resources
      ? { ...documentPreviewInput(document, t), ...loaded.input }
      : documentPreviewInput(document, t)
  return (
    <div className="rightbar-document-preview" data-rightbar-document-preview={document?.id ?? 'empty'}>
      <DocumentPreview {...input} />
    </div>
  )
}
export function RightbarDocumentTab({
  document,
  resources,
  t = (key) => key,
}: {
  document: RightbarDocument | undefined
  resources?: ClientResourceService
  t?: (key: string) => string
}): JSX.Element {
  const kind = document?.kind ?? 'text'
  return (
    <section className="rightbar-tab-content" data-rightbar-tab="document">
      <SlotOutlet
        name="sidebar.right.tab.document"
        entryKey={kind}
        props={{ owner: document }}
        fallback={
          <DocumentPreviewBuiltin
            document={document}
            {...(resources === undefined ? {} : { resources })}
            t={t}
          />
        }
      />
    </section>
  )
}
export function RightbarGuideTab({ t = (key) => key }: { t?: (key: string) => string }): JSX.Element {
  return (
    <section className="rightbar-tab-content" data-rightbar-tab="guide">
      <SlotOutlet
        name="sidebar.right.tab.guide"
        owner={{ tabId: 'guide' }}
        fallback={
          <EmptyState
            icon={<Icon name="file-text" />}
            title={t('app.guide.title')}
            description={t('app.guide.empty')}
          />
        }
      />
      <SlotOutlet
        name="sidebar.right.tab.guide.entry"
        entryKey="default"
        props={{ owner: { entryId: 'default', tabId: 'guide' } }}
        hideWhenEmpty={true}
      />
    </section>
  )
}
export function RightbarTabBuiltin({
  tab,
  document,
  resources,
  t = (key) => key,
}: {
  tab: 'document' | 'guide'
  document: RightbarDocument | undefined
  resources?: ClientResourceService
  t?: (key: string) => string
}): JSX.Element {
  return tab === 'document' ? (
    <RightbarDocumentTab document={document} {...(resources === undefined ? {} : { resources })} />
  ) : (
    <RightbarGuideTab t={t} />
  )
}
export function RightbarSessionBuiltin({
  document,
  t = (key) => key,
}: {
  document: RightbarDocument | undefined
  t?: (key: string) => string
}): JSX.Element {
  const activeTab = document === undefined ? 'guide' : 'document'
  const owner = (tabId: 'document' | 'guide') => ({
    tabId,
    title: tabId === 'document' ? (document?.title ?? t('app.doc.fallbackTitle')) : t('app.guide.title'),
    active: activeTab === tabId,
  })
  return (
    <div id="rightbar-session" data-agnes-rightbar-session={true}>
      <nav className="rightbar-tabs" aria-label={t('app.rightbarTabs')}>
        <SlotOutlet
          name="sidebar.right.pane.tab"
          entryKey="document"
          props={{ owner: owner('document') }}
          hideWhenEmpty={true}
        />
        <SlotOutlet
          name="sidebar.right.pane.tab"
          entryKey="guide"
          props={{ owner: owner('guide') }}
          hideWhenEmpty={true}
        />
        <SlotOutlet
          name="sidebar.right.pane.tab.title"
          entryKey={activeTab}
          props={{ owner: owner(activeTab) }}
          fallback={owner(activeTab).title}
          hideWhenEmpty={true}
        />
        <SlotOutlet
          name="sidebar.right.tab.menu.item"
          props={{ owner: { activeTab } }}
          hideWhenEmpty={true}
        />
      </nav>
    </div>
  )
}
export function RightbarBuiltin(): JSX.Element {
  return (
    <div id="rightbar-content" data-agnes-region-unit="rightbar">
      <SlotOutlet name="rightbar.session" hideWhenEmpty={true} />
    </div>
  )
}
/** Mount the independent DSH rightbar surface; trace and approval keep their legacy owners. */
export function mountRightbarRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: RightbarRegionOptions = {},
  locale?: LocaleService,
): RightbarRegionMount {
  const t = locale ? (key: string) => locale.t(key) : undefined
  const rootSpec = dshSlotSpec('rightbar')
  const sessionSpec = dshSlotSpec('rightbar.session')
  if (!rootSpec || !sessionSpec) throw new Error('rightbar DSH slots are missing from the catalog')
  if (!registry.spec('rightbar')) registry.declare('rightbar', rootSpec, 'web-shell')
  const removeBuiltin = registry.register(
    {
      name: 'rightbar',
      id: 'builtin-rightbar',
      owner: '@agnes/web-rightbar',
      priority: 0,
      children: { 'rightbar.session': sessionSpec },
    },
    () => <RightbarBuiltin />,
  )
  const removeSessionBuiltin = registry.register(
    {
      name: 'rightbar.session',
      id: 'builtin-rightbar-session',
      owner: '@agnes/web-rightbar',
      priority: 1,
      children: RIGHTBAR_SESSION_CHILDREN,
    },
    () => <RightbarSessionBuiltin document={options.document} {...(t ? { t } : {})} />,
  )
  const removeDocumentTab = registry.register(
    {
      name: 'sidebar.right.pane.tab',
      key: 'document',
      id: 'builtin-rightbar-document-tab',
      owner: '@agnes/web-rightbar',
      priority: 1,
      children: RIGHTBAR_DOCUMENT_CHILDREN,
    },
    () => (
      <RightbarTabBuiltin
        tab="document"
        document={options.document}
        {...(options.resources === undefined ? {} : { resources: options.resources })}
      />
    ),
  )
  const removeGuideTab = registry.register(
    {
      name: 'sidebar.right.pane.tab',
      key: 'guide',
      id: 'builtin-rightbar-guide-tab',
      owner: '@agnes/web-rightbar',
      priority: 1,
      children: RIGHTBAR_GUIDE_CHILDREN,
    },
    () => (
      <RightbarTabBuiltin
        tab="guide"
        document={options.document}
        {...(options.resources === undefined ? {} : { resources: options.resources })}
      />
    ),
  )
  const documentRenderers: Array<() => void> = []
  for (const kind of ['text', 'markdown', 'html', 'image', 'pdf', 'code'] as const) {
    documentRenderers.push(
      registry.register(
        {
          name: 'sidebar.right.tab.document',
          key: kind,
          id: `builtin-rightbar-document-${kind}`,
          owner: '@agnes/web-rightbar',
          priority: 1,
        },
        ({ owner }: { owner?: RightbarDocument }) => (
          <DocumentPreviewBuiltin
            document={owner ?? options.document}
            {...(options.resources === undefined ? {} : { resources: options.resources })}
            {...(t ? { t } : {})}
          />
        ),
      ),
    )
  }
  const root = createRegionRenderer(container)
  const watchedSlots = [
    'rightbar',
    'rightbar.session',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'sidebar.right.tab.document',
    'sidebar.right.tab.guide',
    'sidebar.right.tab.guide.entry',
    'sidebar.right.tab.menu.item',
  ]
  const hasCustomRightbarEntry = (): boolean =>
    options.document !== undefined ||
    watchedSlots.some((name) => registry.entries(name).some((entry) => entry.owner !== '@agnes/web-rightbar'))
  const syncVisibility = (): void => {
    container.hidden = !hasCustomRightbarEntry()
  }
  const stops = watchedSlots.map((name) => registry.subscribeBatched(name, syncVisibility))
  flushSync(() => {
    root.render(
      <SlotsProvider registry={registry} {...(options.session ? { session: options.session } : {})}>
        <SlotOutlet name="rightbar" />
      </SlotsProvider>,
    )
  })
  syncVisibility()
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      for (const stop of stops) stop()
      root.unmount()
      for (const remove of documentRenderers) remove()
      removeGuideTab()
      removeDocumentTab()
      removeSessionBuiltin()
      removeBuiltin()
      container.hidden = true
    },
  }
}
