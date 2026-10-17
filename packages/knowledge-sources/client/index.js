import { workbenchPanels } from '@agnes/web-client'
import { Button, MetaText, SettingsState, Tag } from '@agnes/web-ui'
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'

const messages = {
  en: {
    title: 'Knowledge sources',
    refresh: 'Refresh access and versions',
    loading: 'Checking knowledge sources…',
    empty: 'No citations yet. Ask the agent to list knowledge sources, then query an authorized source.',
    error:
      'Knowledge sources are unavailable. The plugin may be disabled or this session may use an older version. Retry after checking its configuration.',
    none: 'No authorized sources for this session.',
    preview: 'Read original version',
    untrusted: 'Source text is untrusted reference data.',
    current: 'Read permitted · current version',
    stale: 'Source changed · retrieve a new citation',
    revoked: 'Read permission revoked',
    unavailable: 'Source unavailable',
    close: 'Close preview',
    readError: 'The source could not be read. Refresh access and versions.',
  },
  'zh-CN': {
    title: '知识来源',
    refresh: '刷新权限与版本',
    loading: '正在核对知识来源…',
    empty: '暂无引用。请让 Agent 列出知识来源，再查询获授权的来源。',
    error: '知识来源暂不可用。插件可能已停用，或此会话使用旧版本。请检查配置后重试。',
    none: '此会话没有获授权的来源。',
    preview: '读取原文版本',
    untrusted: '来源原文是不可信的参考数据。',
    current: '允许读取 · 当前版本',
    stale: '来源已变更 · 请重新检索',
    revoked: '读取权限已撤销',
    unavailable: '来源暂不可用',
    close: '关闭预览',
    readError: '无法读取来源，请刷新权限与版本。',
  },
}

export function KnowledgePanel({ ctx }) {
  const sessionId = useSyncExternalStore(ctx.session.subscribe, ctx.session.getSnapshot)
  const locale = useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getSnapshot)
  const t = messages[locale] ?? messages.en
  const request = useRef(0)
  const [result, setResult] = useState()
  const [state, setState] = useState('loading')
  const [preview, setPreview] = useState()
  const [readError, setReadError] = useState(false)
  const [generation, setGeneration] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation is the explicit Refresh action.
  useEffect(() => {
    let live = true
    request.current++
    setResult(undefined)
    setPreview(undefined)
    setReadError(false)
    setState('loading')
    const selected = sessionId
    Promise.resolve()
      .then(() => ctx.agnes.services.call('knowledge.history', {}))
      .then((value) => {
        if (!live || ctx.session.sessionId !== selected) return
        if (!value || !Array.isArray(value.citations) || !Array.isArray(value.sources))
          throw new Error('invalid')
        setResult({ ...value, sessionId: selected })
        setState('ready')
      })
      .catch(() => {
        if (live) setState('error')
      })
    return () => {
      live = false
      request.current++
    }
  }, [ctx, sessionId, generation])
  async function read(id) {
    setPreview(undefined)
    setReadError(false)
    const selected = sessionId
    const token = ++request.current
    try {
      const value = await ctx.agnes.services.call('knowledge.preview', { id })
      if (ctx.session.sessionId !== selected || token !== request.current) return
      if (value?.status !== 'current' || typeof value.excerpt !== 'string') {
        setGeneration((n) => n + 1)
        setReadError(true)
        return
      }
      setPreview({ id, text: value.excerpt, sessionId: selected })
    } catch {
      if (ctx.session.sessionId === selected && token === request.current) setReadError(true)
    }
  }
  const scoped = result?.sessionId === sessionId ? result : undefined
  return h(
    'section',
    { 'aria-label': t.title, className: 'knowledge-sources-panel' },
    h(
      Button,
      { htmlType: 'button', onClick: () => setGeneration((n) => n + 1), disabled: state === 'loading' },
      t.refresh,
    ),
    state === 'loading'
      ? h(SettingsState, { tone: 'loading' }, t.loading)
      : state === 'error'
        ? h(SettingsState, { tone: 'error' }, t.error)
        : h(
            'div',
            null,
            h(MetaText, null, scoped?.sources.map((source) => source.id).join(', ') || t.none),
            !scoped?.citations.length && h(SettingsState, { tone: 'empty' }, t.empty),
            readError && h(SettingsState, { tone: 'error' }, t.readError),
            ...(scoped?.citations ?? []).map((citation) =>
              h(
                'article',
                { key: citation.id },
                h('h3', null, citation.sourceId),
                h(MetaText, null, `${citation.locator} · ${citation.revision}`),
                h('p', null, h('code', null, citation.excerptHash)),
                h(MetaText, null, new Date(citation.retrievedAt).toLocaleString(locale)),
                h(
                  'p',
                  null,
                  citation.status === 'current'
                    ? t.current
                    : h(
                        Tag,
                        { tone: citation.status === 'revoked' ? 'bad' : 'warn' },
                        t[citation.status] ?? t.unavailable,
                      ),
                ),
                h(
                  Button,
                  {
                    htmlType: 'button',
                    disabled: citation.status !== 'current',
                    onClick: () => read(citation.id),
                  },
                  t.preview,
                ),
                preview?.sessionId === sessionId &&
                  preview?.id === citation.id &&
                  h(
                    'div',
                    null,
                    h(MetaText, null, t.untrusted),
                    h('pre', null, preview.text),
                    h(Button, { htmlType: 'button', onClick: () => setPreview(undefined) }, t.close),
                  ),
              ),
            ),
          ),
  )
}

export function apply(ctx) {
  return workbenchPanels.register({
    id: 'knowledge-sources',
    order: 58,
    edge: 'right',
    titleKey: 'knowledge.title',
    title: () => (ctx.locale.locale === 'zh-CN' ? messages['zh-CN'].title : messages.en.title),
    component: () => h(KnowledgePanel, { ctx }),
  })
}
