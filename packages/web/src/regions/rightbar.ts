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
import { createAntdRoot } from '@agnes/web-ui'
import { DocumentPreview } from '@agnes/web-ui/assistant-ui'

import { createElement, useLayoutEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  type EmptyStateRegionMount,
  RIGHTBAR_SESSION_CHILDREN,
  RIGHTBAR_DOCUMENT_CHILDREN,
  RIGHTBAR_GUIDE_CHILDREN,
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
}): ReturnType<typeof createElement> {
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
  return createElement(
    'div',
    {
      className: 'rightbar-document-preview',
      'data-rightbar-document-preview': document?.id ?? 'empty',
    },
    createElement(DocumentPreview, input),
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
}): ReturnType<typeof createElement> {
  const kind = document?.kind ?? 'text'
  return createElement(
    'section',
    { className: 'rightbar-tab-content', 'data-rightbar-tab': 'document' },
    createElement(SlotOutlet, {
      name: 'sidebar.right.tab.document',
      entryKey: kind,
      props: { owner: document },
      fallback: createElement(DocumentPreviewBuiltin, {
        document,
        ...(resources === undefined ? {} : { resources }),
        t,
      }),
    }),
  )
}

export function RightbarGuideTab({
  t = (key) => key,
}: {
  t?: (key: string) => string
}): ReturnType<typeof createElement> {
  return createElement(
    'section',
    { className: 'rightbar-tab-content', 'data-rightbar-tab': 'guide' },
    createElement(SlotOutlet, {
      name: 'sidebar.right.tab.guide',
      owner: { tabId: 'guide' },
      fallback: t('app.guide.empty'),
    }),
    createElement(SlotOutlet, {
      name: 'sidebar.right.tab.guide.entry',
      entryKey: 'default',
      props: { owner: { entryId: 'default', tabId: 'guide' } },
      hideWhenEmpty: true,
    }),
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
}): ReturnType<typeof createElement> {
  return tab === 'document'
    ? createElement(RightbarDocumentTab, {
        document,
        ...(resources === undefined ? {} : { resources }),
      })
    : createElement(RightbarGuideTab, { t })
}

export function RightbarSessionBuiltin({
  document,
  t = (key) => key,
}: {
  document: RightbarDocument | undefined
  t?: (key: string) => string
}): ReturnType<typeof createElement> {
  const activeTab = document === undefined ? 'guide' : 'document'
  const owner = (tabId: 'document' | 'guide') => ({
    tabId,
    title: tabId === 'document' ? (document?.title ?? t('app.doc.fallbackTitle')) : t('app.guide.title'),
    active: activeTab === tabId,
  })
  return createElement(
    'div',
    { id: 'rightbar-session', 'data-agnes-rightbar-session': true },
    createElement(
      'nav',
      { className: 'rightbar-tabs', 'aria-label': t('app.rightbarTabs') },
      createElement(SlotOutlet, {
        name: 'sidebar.right.pane.tab',
        entryKey: 'document',
        props: { owner: owner('document') },
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'sidebar.right.pane.tab',
        entryKey: 'guide',
        props: { owner: owner('guide') },
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'sidebar.right.pane.tab.title',
        entryKey: activeTab,
        props: { owner: owner(activeTab) },
        fallback: owner(activeTab).title,
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'sidebar.right.tab.menu.item',
        props: { owner: { activeTab } },
        hideWhenEmpty: true,
      }),
    ),
  )
}

export function RightbarBuiltin(): ReturnType<typeof createElement> {
  return createElement(
    'div',
    { id: 'rightbar-content', 'data-agnes-region-unit': 'rightbar' },
    createElement(SlotOutlet, { name: 'rightbar.session', hideWhenEmpty: true }),
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
    () => createElement(RightbarBuiltin),
  )
  const removeSessionBuiltin = registry.register(
    {
      name: 'rightbar.session',
      id: 'builtin-rightbar-session',
      owner: '@agnes/web-rightbar',
      priority: 1,
      children: RIGHTBAR_SESSION_CHILDREN,
    },
    () =>
      createElement(RightbarSessionBuiltin, {
        document: options.document,
        ...(t ? { t } : {}),
      }),
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
    () =>
      createElement(RightbarTabBuiltin, {
        tab: 'document',
        document: options.document,
        ...(options.resources === undefined ? {} : { resources: options.resources }),
      }),
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
    () =>
      createElement(RightbarTabBuiltin, {
        tab: 'guide',
        document: options.document,
        ...(options.resources === undefined ? {} : { resources: options.resources }),
      }),
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
        ({ owner }: { owner?: RightbarDocument }) =>
          createElement(DocumentPreviewBuiltin, {
            document: owner ?? options.document,
            ...(options.resources === undefined ? {} : { resources: options.resources }),
            ...(t ? { t } : {}),
          }),
      ),
    )
  }
  const root = createAntdRoot(container)
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
      createElement(
        SlotsProvider,
        { registry, ...(options.session ? { session: options.session } : {}) },
        createElement(SlotOutlet, { name: 'rightbar' }),
      ),
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
