import {
  DeliverablesStore,
  factChainLinks,
  groupDeliveredFiles,
  surfaceDeliverables,
  workbenchNavigation,
} from '@agnes/web-client'
import { Button, Disclosure, EmptyState, Icon, IconButton, ListRow, Menu, StatusMessage } from '@agnes/web-ui'
import { DocumentPreview, HtmlPreviewFrame } from '@agnes/web-ui/conversation'
import { Fragment, createElement as h, useEffect, useState, useSyncExternalStore } from 'react'

/** Immutable snapshot preview and download; the backend authorizes both resource loaders. */
export function FileCard({ file, ctx, inline = false, subtitle }) {
  const [preview, setPreview] = useState()
  const [error, setError] = useState()
  const [notice, setNotice] = useState()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
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
            : mime.startsWith('text/') || ['application/json', 'application/javascript'].includes(mime)
              ? 'text'
              : undefined
  const previewable = Boolean(kind) && file.artifact.size <= 1024 * 1024
  // Inline cards carry no action of their own, so the row text must say what clicking does.
  const unsupported = previewable
    ? undefined
    : zh
      ? '不支持站内预览，点击下载'
      : 'No in-app preview — click to download'
  async function open(ensure = false) {
    if (busy) return
    if (!previewable) {
      // Only a user's click may download; replayed panel selection is not a download request.
      // Selection that cannot open a preview still needs an answer, or the panel looks broken.
      if (!ensure) await download()
      else
        setNotice(
          zh
            ? '该格式不支持站内预览，请在交付物卡片上点击下载。'
            : 'This format has no in-app preview. Use Download on the card.',
        )
      return
    }
    if (inline && file.workbench) {
      if (ctx.requestPreview) ctx.requestPreview(file.id)
      else workbenchNavigation.open('deliverables')
      return
    }
    if (preview) {
      if (ensure) return
      preview.release()
      owner.releases.delete(preview.release)
      setPreview(undefined)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
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
  async function copyName() {
    try {
      await navigator.clipboard.writeText(file.name)
      if (owner.live) setCopied(true)
    } catch {
      if (owner.live) setCopied(false)
    }
  }
  // A turn card names the exact snapshot requested, including earlier versions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: consume a navigation request once; preview state must not toggle it again.
  useEffect(() => {
    if (!inline && (typeof ctx.selection === 'string' ? ctx.selection : ctx.selection?.id) === file.id)
      void open(true)
  }, [ctx.selection, file.id, inline])
  const type =
    mime === 'text/html'
      ? 'html'
      : mime === 'application/pdf'
        ? 'pdf'
        : mime.startsWith('image/')
          ? 'image'
          : mime === 'text/markdown'
            ? 'markdown'
            : mime.startsWith('text/')
              ? 'text'
              : 'file'
  const icon = type === 'html' ? 'globe' : type === 'image' ? 'eye' : type === 'file' ? 'file' : 'file-text'
  const size = file.artifact.size
  const unit = size >= 1024 * 1024 ? 1024 * 1024 : 1024
  const formatted =
    size > 0 && size < 1024
      ? '<1 KiB'
      : `${new Intl.NumberFormat(ctx.locale.locale, { maximumFractionDigits: 1 }).format(size / unit)} ${unit === 1024 ? 'KiB' : 'MiB'}`
  return h(
    'section',
    {
      className: 'deliverable-file',
      'data-testid': 'deliverable-file',
      'data-placement': inline ? 'inline' : 'workbench',
      'data-open': !!preview,
    },
    h(ListRow, {
      variant: 'file',
      title: file.name,
      titleClassName: 'deliverable-target',
      titleLabel: `${previewable ? (zh ? '打开' : 'Open') : zh ? '下载' : 'Download'}: ${file.name}`,
      description: [subtitle ?? [file.description, formatted].filter(Boolean).join(' · '), unsupported]
        .filter(Boolean)
        .join(' · '),
      icon: h('span', { className: 'deliverable-tile', 'data-type': type }, h(Icon, { name: icon })),
      // Workbench titles are labels; the explicit Open action owns preview activation.
      onOpen: inline
        ? () => {
            void open()
          }
        : undefined,
      // A card inside an answer opens on click and shows no trailing action, so no lone menu
      // chevron floats beside it. The workbench card keeps the Open / Open-with split control.
      actions: inline
        ? undefined
        : h(
            Fragment,
            null,
            h(
              Button,
              {
                size: 'small',
                className: 'deliverable-open',
                'data-testid': 'deliverable-open',
                disabled: busy,
                'aria-expanded': previewable ? !!preview : undefined,
                onClick: () => {
                  void open()
                },
              },
              !previewable
                ? zh
                  ? '下载'
                  : 'Download'
                : zh
                  ? preview
                    ? '关闭'
                    : '打开'
                  : preview
                    ? 'Close'
                    : 'Open',
            ),
            h(Menu, {
              label: zh ? '打开方式' : 'Open with',
              trigger: h(IconButton, {
                name: 'chevron-down',
                label: zh ? '打开方式' : 'Open with',
                className: 'deliverable-open-with',
                'data-testid': 'deliverable-open-with',
                disabled: busy,
              }),
              items: [
                ...(previewable
                  ? [
                      {
                        id: 'open',
                        label: zh ? '在工作台中预览' : 'Preview in workbench',
                        testId: 'deliverable-in-workbench',
                        onSelect: () => {
                          void open()
                        },
                      },
                    ]
                  : []),
                {
                  id: 'download',
                  label: zh ? '下载' : 'Download',
                  testId: 'deliverable-download',
                  onSelect: () => {
                    void download()
                  },
                },
                {
                  id: 'copy-name',
                  label: zh ? (copied ? '已复制' : '复制文件名') : copied ? 'Copied' : 'Copy file name',
                  onSelect: () => {
                    void copyName()
                  },
                },
              ],
            }),
          ),
    }),
    error && h(StatusMessage, { kind: 'error' }, error),
    notice && h(StatusMessage, { kind: 'notice', 'data-testid': 'deliverable-preview-unsupported' }, notice),
    preview &&
      h(
        'div',
        { className: 'deliverable-preview' },
        preview.kind === 'html'
          ? h(HtmlPreviewFrame, { html: preview.content ?? '', title: file.name })
          : h(DocumentPreview, {
              kind: preview.kind === 'text' ? 'code' : preview.kind,
              title: file.name,
              content: preview.content,
              resourceUrl: preview.url,
              t: (key) => ctx.locale.t(key),
            }),
      ),
  )
}

function History({ earlier, latest, ctx, inline, zh, onChoose }) {
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
      className: inline ? 'turn-deliverable-earlier' : 'workbench-deliverables-earlier',
      open,
      onOpenChange: setOpen,
      summary: zh ? `同名文件历史 · ${earlier.length}` : `Files of this name (${earlier.length})`,
    },
    h(
      'ul',
      { className: 'turn-deliverables-list' },
      earlier.map((file, index) => {
        const current = latest ?? file.historyLatest
        const time =
          file.presentedAt === undefined
            ? `${zh ? '版本' : 'Version'} ${index + 1}`
            : new Intl.DateTimeFormat(ctx.locale.locale, { hour: '2-digit', minute: '2-digit' }).format(
                new Date(file.presentedAt),
              ) + (zh ? ' 展示' : ' presented')
        const delta = current && file.artifact.size - current.artifact.size
        const difference =
          delta === undefined
            ? undefined
            : delta === 0
              ? zh
                ? '大小相同'
                : 'Same size'
              : `${zh ? (delta < 0 ? '比最新的小' : '比最新的大') : delta < 0 ? 'Smaller by' : 'Larger by'} ${Math.abs(delta) < 1024 ? '<1 KiB' : `${(Math.abs(delta) / 1024).toFixed(1)} KiB`}`
        const subtitle = [
          zh ? `来自 ${file.source.owner}` : `From ${file.source.owner}`,
          time,
          difference,
          file.description,
        ]
          .filter(Boolean)
          .join(' · ')
        return h(
          'li',
          { key: file.id, onClickCapture: () => onChoose?.(file.id) },
          h(FileCard, { file, ctx, inline, subtitle }),
        )
      }),
    ),
  )
}

export function FileList({ files, ctx, inline = false }) {
  const zh = ctx.locale.locale === 'zh-CN'
  const [chosen, setChosen] = useState()
  const selectedId = typeof ctx.selection === 'string' ? ctx.selection : ctx.selection?.id
  useEffect(() => {
    const id = typeof ctx.selection === 'string' ? ctx.selection : ctx.selection?.id
    if (id) setChosen(id)
  }, [ctx.selection])
  const groups = groupDeliveredFiles(files)
  if (!groups.length)
    return h(EmptyState, {
      icon: h(Icon, { name: 'file' }),
      title: zh ? '交付物' : 'Deliverables',
      description: zh ? '尚无交付物。' : 'No delivered files yet.',
    })
  const rows = (items) =>
    h(
      'ul',
      { className: inline ? 'turn-deliverables-list' : undefined },
      items.map(({ latest, earlier }) =>
        h(
          'li',
          {
            key: latest.id,
            'data-chosen': (chosen ?? selectedId ?? groups[0]?.latest.id) === latest.id,
            onClickCapture: () => setChosen(latest.id),
          },
          h(FileCard, { file: latest, ctx, inline }),
          inline &&
            earlier.length > 0 &&
            h(History, { earlier, latest, ctx, inline, zh, onChoose: setChosen }),
        ),
      ),
    )
  if (inline)
    return h(
      'section',
      {
        className: 'turn-deliverables',
        'data-testid': 'turn-deliverables',
        'aria-label': zh ? '交付物' : 'Deliverables',
      },
      groups.length > 1 &&
        h(
          'p',
          { className: 'turn-deliverables-head' },
          `${zh ? '交付物' : 'Deliverables'} · ${groups.length}`,
        ),
      rows(groups),
    )
  const version = (file) =>
    file.description
      .replace(/^[^\s:]+:\s+/, '')
      .trim()
      .toLowerCase()
  const section = (title, items) =>
    items.length > 0 &&
    h('section', { key: title, className: 'workbench-deliverables-group' }, h('h4', null, title), rows(items))
  const earlier = groups.flatMap((group) =>
    group.earlier.map((file) => ({ ...file, historyLatest: group.latest })),
  )
  const current = files.find((file) => file.id === (chosen ?? selectedId)) ?? groups[0]?.latest
  return h(
    'section',
    {
      className: 'workbench-deliverables',
      'data-testid': 'workbench-deliverables',
      'aria-label': zh ? '交付物' : 'Deliverables',
    },
    h(
      'div',
      { className: 'workbench-deliverables-scroll' },
      section(
        zh ? '最终版' : 'Final',
        groups.filter(({ latest }) => version(latest) === 'final'),
      ),
      section(
        zh ? '审阅稿' : 'Review draft',
        groups.filter(({ latest }) => ['draft', 'review draft'].includes(version(latest))),
      ),
      section(
        zh ? '文件' : 'Files',
        groups.filter(({ latest }) => !['final', 'draft', 'review draft'].includes(version(latest))),
      ),
      earlier.length > 0 && h(History, { earlier, ctx, inline, zh, onChoose: setChosen }),
    ),
    h(
      'footer',
      { className: 'workbench-tab-footer' },
      h(Icon, { name: 'info', size: 16 }),
      h(
        'p',
        null,
        zh
          ? '每个交付物都能追到产生它的工具调用'
          : 'Each deliverable links to the tool call that produced it',
      ),
      current?.source.toolUseId &&
        h(
          Button,
          {
            type: 'link',
            size: 'small',
            'data-testid': 'deliverables-source',
            onClick: () =>
              factChainLinks.open({
                sessionId: current.sessionId,
                laneId: current.laneId,
                anchor: { kind: 'tool', toolUseId: current.source.toolUseId },
              }),
          },
          zh ? '在轨迹中查看' : 'View in trace',
        ),
    ),
  )
}

export function mountPresentation(ctx) {
  const store = new DeliverablesStore(ctx.agnes, ctx.session)
  // Cordis contexts reject reads of services that were not injected. Selection belongs to panels.
  let selection
  const requests = new Set()
  const subscribe = (listener) => {
    requests.add(listener)
    return () => requests.delete(listener)
  }
  const read = () => selection
  const cardContext = {
    locale: ctx.locale,
    resources: ctx.resources,
    selection: undefined,
    requestPreview: (id) => {
      selection = { id }
      for (const listener of requests) listener()
      workbenchNavigation.open('deliverables')
    },
  }
  function Panel() {
    const selected = useSyncExternalStore(subscribe, read)
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
    if (snapshot.sessionId !== ctx.session.sessionId) return null
    const panelContext = { ...cardContext, selection: selected }
    return h(
      Fragment,
      null,
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
      h(FileList, { files: snapshot.files.filter((file) => file.workbench), ctx: panelContext }),
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
    return files.length ? h(FileList, { files, ctx: cardContext, inline: true }) : null
  }
  const stops = []
  try {
    stops.push(
      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'deliverables-tail',
            priority: 0,
            select: (owner) => (owner?.turn ? owner : null),
          },
          Tail,
        ),
      ),
    )
    stops.push(
      ctx.workbenchPanels.register({
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
      ctx.conversationCards.register({
        id: 'delivered-surfaces',
        order: 0,
        matches: (card) =>
          card.kind === 'intelligent-ui.surface' &&
          card.data?.surface?.components?.length > 0 &&
          card.data.surface.components.every((component) => component.kind === 'artifact-file'),
        component: ({ card }) =>
          h(FileList, { files: surfaceDeliverables(ctx.session.sessionId, card.data), ctx: cardContext }),
      }),
    )
    stops.push(
      ctx.conversationCards.register({
        id: 'delivered-artifact',
        order: 0,
        matches: (card) => card.kind === 'artifact-file',
        component: ({ card }) =>
          h(FileCard, {
            ctx: cardContext,
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
    mount: (child) => mountPresentation(child),
  })
}
