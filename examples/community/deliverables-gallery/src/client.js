import { DeliverablesStore } from '@agnes/web-client'
import { Button, EmptyState, Icon, ListRow, StatusMessage } from '@agnes/web-ui'
import { DocumentPreview, HtmlPreviewFrame } from '@agnes/web-ui/conversation'
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'

function GalleryCard({ file, ctx }) {
  const zh = ctx.locale.locale === 'zh-CN'
  const [resource, setResource] = useState()
  const [error, setError] = useState()
  const [owner] = useState(() => ({ live: true, releases: new Set() }))
  useEffect(() => {
    owner.live = true
    return () => {
      owner.live = false
      for (const release of owner.releases) release()
      owner.releases.clear()
    }
  }, [owner])
  async function read(download) {
    setError(undefined)
    try {
      const next = download
        ? await ctx.resources.files.load({ laneId: file.laneId, artifact: file.artifact })
        : await ctx.resources.documents.load({
            laneId: file.laneId,
            artifact: file.artifact,
            kind: ['image/png', 'image/jpeg'].includes(file.artifact.mime)
              ? 'image'
              : file.artifact.mime === 'application/pdf'
                ? 'pdf'
                : file.artifact.mime === 'text/html'
                  ? 'html'
                  : 'text',
          })
      if (!owner.live) {
        next.release()
        return
      }
      owner.releases.add(next.release)
      if (download) {
        const link = document.createElement('a')
        link.href = next.url
        link.download = file.name
        link.click()
        const release = () => {
          clearTimeout(timer)
          next.release()
          owner.releases.delete(release)
        }
        const timer = setTimeout(release, 1000)
        owner.releases.delete(next.release)
        owner.releases.add(release)
      } else {
        resource?.release()
        setResource(next)
      }
    } catch (cause) {
      if (owner.live) setError(String(cause.message ?? cause))
    }
  }
  return h(
    'section',
    null,
    h(ListRow, {
      title: file.name,
      description: file.description,
      icon: h(Icon, { name: 'file' }),
      meta: `${file.source.owner} · ${file.artifact.size} B`,
      onOpen: () => {
        void read(false)
      },
      actions: h(
        Button,
        {
          onClick: () => {
            void read(true)
          },
        },
        zh ? '下载' : 'Download',
      ),
    }),
    error && h(StatusMessage, { kind: 'error' }, error),
    resource &&
      h(
        'div',
        { className: 'deliverable-preview' },
        resource.kind === 'html'
          ? h(HtmlPreviewFrame, { html: resource.content ?? '', title: file.name })
          : h(DocumentPreview, {
              kind: resource.kind,
              title: file.name,
              content: resource.content,
              resourceUrl: resource.url,
              t: (key) => ctx.locale.t(key),
            }),
      ),
  )
}
export function apply(ctx) {
  return ctx.presentationRoles.register({
    role: 'deliverables',
    priority: 0,
    mount(ctx) {
      const store = new DeliverablesStore(ctx.agnes, ctx.session)
      function Gallery({ turn }) {
        const zh = ctx.locale.locale === 'zh-CN'
        const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
        if (snapshot.sessionId !== ctx.session.sessionId) return null
        const files = snapshot.files
          .filter((file) => (turn ? file.inline : file.workbench))
          .filter(
            (file) =>
              !turn ||
              file.turnId === turn.id ||
              (!file.turnId &&
                file.seq >= turn.startSeq &&
                (turn.endSeq === undefined || file.seq <= turn.endSeq)),
          )
        return h(
          'section',
          {
            'aria-label': zh ? '交付物图库' : 'Deliverables gallery',
            'data-testid': 'deliverables-gallery',
            className: turn ? undefined : 'workbench-deliverables-scroll',
          },
          snapshot.error &&
            h(
              StatusMessage,
              { kind: 'error', action: { label: zh ? '重试' : 'Retry', onSelect: store.refresh } },
              snapshot.error,
            ),
          snapshot.loading &&
            h(StatusMessage, { kind: 'pending' }, zh ? '正在读取快照…' : 'Loading snapshots…'),
          ...files.map((file) => h(GalleryCard, { key: file.id, file, ctx })),
          !files.length &&
            !snapshot.loading &&
            h(EmptyState, {
              icon: h(Icon, { name: 'file' }),
              title: zh ? '图库' : 'Gallery',
              description: zh ? '交付文件后即可查看快照。' : 'Present files to see their snapshots.',
            }),
        )
      }
      const stops = []
      try {
        stops.push(
          ctx.slots.inject('conversation.chat.turnTail', () =>
            ctx.slots.register(
              {
                name: 'conversation.chat.turnTail',
                id: 'gallery-tail',
                select: (owner) => (owner?.turn ? owner : null),
              },
              ({ value }) => h(Gallery, { turn: value.turn }),
            ),
          ),
        )
        stops.push(
          ctx.workbenchPanels.register({
            id: 'deliverables-gallery',
            edge: 'right',
            order: 55,
            titleKey: 'Gallery',
            title: () => (ctx.locale.locale === 'zh-CN' ? '图库' : 'Gallery'),
            count: { subscribe: store.subscribe, read: () => store.getSnapshot().files.length },
            component: () => h(Gallery),
          }),
        )
        stops.push(
          ctx.conversationCards.register({
            id: 'gallery-surfaces',
            order: 0,
            matches: (card) =>
              card.kind === 'intelligent-ui.surface' &&
              card.data?.surface?.components?.length > 0 &&
              card.data.surface.components.every((component) => component.kind === 'artifact-file'),
            component: () => h(Gallery),
          }),
        )
        stops.push(
          ctx.conversationCards.register({
            id: 'gallery-artifact',
            order: 0,
            matches: (card) => card.kind === 'artifact-file',
            component: ({ card }) =>
              h(GalleryCard, {
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
    },
  })
}
