import {
  conversationCards,
  DeliverablesStore,
  groupDeliveredFiles,
  surfaceDeliverables,
  workbenchNavigation,
  workbenchPanels,
} from '@agnes/web-client'
import { Button, Disclosure, EmptyState, Icon, ListRow, Menu, StatusMessage } from '@agnes/web-ui'
import { DocumentPreview, HtmlPreviewFrame } from '@agnes/web-ui/conversation'
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'

/** Immutable snapshot preview and download; the backend authorizes both resource loaders. */
export function FileCard({ file, ctx, inline = false }) {
  const [preview, setPreview] = useState()
  const [error, setError] = useState()
  const [busy, setBusy] = useState(false)
  const [owner] = useState(() => ({ live: true, releases: new Set() }))
  useEffect(() => {
    owner.live = true
    return () => {
      owner.live = false
      for (const release of owner.releases) release()
      owner.releases.clear()
    }
  }, [owner])
  const zh = ctx.locale.locale === 'zh-CN'
  async function open() {
    if (inline && file.workbench) {
      workbenchNavigation.open('deliverables', { id: file.id })
      return
    }
    if (busy) return
    if (preview) {
      preview.release()
      owner.releases.delete(preview.release)
      setPreview(undefined)
      return
    }
    setBusy(true)
    setError(undefined)
    const mime = file.artifact.mime
    const kind =
      mime === 'text/html'
        ? 'html'
        : mime === 'text/markdown'
          ? 'markdown'
          : mime === 'application/pdf'
            ? 'pdf'
            : ['image/png', 'image/jpeg'].includes(mime)
              ? 'image'
              : mime.startsWith('text/') || mime === 'application/json'
                ? 'text'
                : undefined
    try {
      if (!kind || file.artifact.size > 1024 * 1024)
        throw new Error(zh ? '请下载此文件查看。' : 'Download this file to view it.')
      const resource = await ctx.resources.documents.load({
        laneId: file.laneId,
        artifact: file.artifact,
        kind,
      })
      if (!owner.live) {
        resource.release()
        return
      }
      owner.releases.add(resource.release)
      setPreview(resource)
    } catch (cause) {
      if (owner.live) setError(String(cause.message ?? cause))
    } finally {
      if (owner.live) setBusy(false)
    }
  }
  async function download() {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const resource = await ctx.resources.files.load({ laneId: file.laneId, artifact: file.artifact })
      if (!owner.live) {
        resource.release()
        return
      }
      const link = document.createElement('a')
      link.href = resource.url
      link.download = file.name
      link.click()
      const release = () => {
        clearTimeout(timer)
        resource.release()
        owner.releases.delete(release)
      }
      const timer = setTimeout(release, 1000)
      owner.releases.add(release)
    } catch (cause) {
      if (owner.live) setError(String(cause.message ?? cause))
    } finally {
      if (owner.live) setBusy(false)
    }
  }
  // A turn card names the exact snapshot requested, including earlier versions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: consume a navigation request once; preview state must not toggle it again.
  useEffect(() => {
    if (!inline && (typeof ctx.selection === 'string' ? ctx.selection : ctx.selection?.id) === file.id)
      void open()
  }, [ctx.selection, file.id, inline])
  return h(
    ListRow,
    {
      title: file.name,
      description: file.description,
      icon: h(Icon, { name: 'file' }),
      meta: `${file.source.owner} · ${file.laneId} · ${file.artifact.size} B`,
      onOpen: () => {
        void open()
      },
      'data-testid': 'deliverable-file',
      actions: h(Menu, {
        label: zh ? '文件操作' : 'File actions',
        trigger: h(Button, { loading: busy }, zh ? '操作' : 'Actions'),
        items: [
          {
            id: 'open',
            label: zh ? '打开' : 'Open',
            onSelect: () => {
              void open()
            },
          },
          {
            id: 'download',
            label: zh ? '下载' : 'Download',
            onSelect: () => {
              void download()
            },
          },
        ],
      }),
    },
    error && h(StatusMessage, { kind: 'error' }, error),
    preview &&
      (preview.kind === 'html'
        ? h(HtmlPreviewFrame, { html: preview.content ?? '', title: file.name })
        : h(DocumentPreview, {
            kind: preview.kind === 'text' ? 'code' : preview.kind,
            title: file.name,
            content: preview.content,
            resourceUrl: preview.url,
            t: (key) => ctx.locale.t(key),
          })),
  )
}

function History({ earlier, ctx, inline, zh }) {
  const [open, setOpen] = useState(false)
  const selectedId = typeof ctx.selection === 'string' ? ctx.selection : ctx.selection?.id
  const selected = earlier.some((file) => file.id === selectedId) ? ctx.selection : undefined
  useEffect(() => {
    if (selected) setOpen(true)
  }, [selected])
  return h(
    Disclosure,
    {
      variant: 'plain',
      open,
      onOpenChange: setOpen,
      summary: zh ? `同名文件历史 (${earlier.length})` : `Files of this name (${earlier.length})`,
    },
    earlier.map((file) => h(FileCard, { key: file.id, file, ctx, inline })),
  )
}

export function FileList({ files, ctx, inline = false }) {
  const zh = ctx.locale.locale === 'zh-CN'
  const groups = groupDeliveredFiles(files)
  if (!groups.length)
    return h(EmptyState, {
      icon: h(Icon, { name: 'file' }),
      title: zh ? '交付物' : 'Deliverables',
      description: zh ? '尚无交付物。' : 'No delivered files yet.',
    })
  const section = (title, groups) =>
    groups.length
      ? h(
          'section',
          { key: title },
          title && h('h4', null, title),
          groups.map(({ latest, earlier }) =>
            h(
              'div',
              { key: latest.id },
              h(FileCard, { key: latest.id, file: latest, ctx, inline }),
              earlier.length > 0 && h(History, { earlier, ctx, inline, zh }),
            ),
          ),
        )
      : null
  if (inline) return section('', groups)
  const version = (file) =>
    file.description
      .replace(/^[^\s:]+:\s+/, '')
      .trim()
      .toLowerCase()
  return h(
    'section',
    { 'aria-label': zh ? '交付物' : 'Deliverables' },
    section(
      zh ? '最终版' : 'Final',
      groups.filter(({ latest }) => version(latest) === 'final'),
    ),
    section(
      zh ? '审阅稿' : 'Review draft',
      groups.filter(({ latest }) => ['draft', 'review draft'].includes(version(latest))),
    ),
    section(
      zh ? '其他文件' : 'Other files',
      groups.filter(({ latest }) => !['final', 'draft', 'review draft'].includes(version(latest))),
    ),
  )
}

export function mountPresentation(ctx) {
  const store = new DeliverablesStore(ctx.agnes, ctx.session)
  function Panel({ context }) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
    if (snapshot.sessionId !== ctx.session.sessionId) return null
    const cardContext = { locale: ctx.locale, resources: ctx.resources, selection: context.selection }
    return h(
      'section',
      { 'data-testid': 'official-deliverables' },
      snapshot.loading &&
        h(
          StatusMessage,
          { kind: 'pending' },
          ctx.locale.locale === 'zh-CN' ? '正在读取交付物…' : 'Loading deliverables…',
        ),
      snapshot.error &&
        h(
          StatusMessage,
          {
            kind: 'error',
            action: { label: ctx.locale.locale === 'zh-CN' ? '重试' : 'Retry', onSelect: store.refresh },
          },
          snapshot.error,
        ),
      h(FileList, { files: snapshot.files.filter((file) => file.workbench), ctx: cardContext }),
    )
  }
  function Tail({ value }) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
    if (!value?.turn || snapshot.sessionId !== ctx.session.sessionId) return null
    const files = snapshot.files
      .filter((file) => file.inline)
      .filter(
        (file) =>
          file.turnId === value.turn.id ||
          (!file.turnId &&
            file.seq >= value.turn.startSeq &&
            (value.turn.endSeq === undefined || file.seq <= value.turn.endSeq)),
      )
    return files.length ? h(FileList, { files, ctx, inline: true }) : null
  }
  const stops = []
  try {
    stops.push(
      ctx.slots.register(
        {
          name: 'conversation.chat.turnTail',
          id: 'deliverables-tail',
          priority: 0,
          select: (owner) => (owner?.turn ? owner : null),
        },
        Tail,
      ),
    )
    stops.push(
      workbenchPanels.register({
        id: 'deliverables',
        order: 55,
        edge: 'right',
        titleKey: 'workbench.deliverables.title',
        title: () => (ctx.locale.locale === 'zh-CN' ? '交付物' : 'Deliverables'),
        visibility: 'contextual',
        when: () => store.getSnapshot().files.some((file) => file.workbench),
        count: {
          subscribe: store.subscribe,
          read: () => groupDeliveredFiles(store.getSnapshot().files.filter((file) => file.workbench)).length,
        },
        component: Panel,
      }),
    )
    stops.push(
      conversationCards.register({
        id: 'delivered-surfaces',
        order: 0,
        matches: (card) =>
          card.kind === 'intelligent-ui.surface' &&
          card.data?.surface?.components?.length > 0 &&
          card.data.surface.components.every((component) => component.kind === 'artifact-file'),
        component: ({ card }) =>
          h(FileList, { files: surfaceDeliverables(ctx.session.sessionId, card.data), ctx }),
      }),
    )
    stops.push(
      conversationCards.register({
        id: 'delivered-artifact',
        order: 0,
        matches: (card) => card.kind === 'artifact-file',
        component: ({ card }) =>
          h(FileCard, {
            ctx,
            file: {
              ...card.data.file,
              id: card.data.file.artifact.sha256,
              sessionId: card.data.sessionId,
              laneId: card.data.laneId,
              source: { owner: 'artifact' },
            },
          }),
      }),
    )
  } catch (error) {
    for (const stop of stops.reverse()) stop()
    store.dispose()
    throw error
  }
  return () => {
    for (const stop of stops.reverse()) stop()
    store.dispose()
  }
}

export function apply(ctx) {
  return ctx.presentationRoles.register({
    role: 'deliverables',
    priority: 100,
    mount: () => mountPresentation(ctx),
  })
}
