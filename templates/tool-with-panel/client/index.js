import React from 'react'

const strings = {
  en: {
    title: 'To-dos',
    input: 'New item',
    add: 'Add',
    loading: 'Loading…',
    saving: 'Saving…',
    empty: 'No items yet.',
    retry: 'Refresh',
    failed: 'Request failed',
    check: 'Check operation',
    approval: 'Approve in the Host Approvals page, then check this operation.',
  },
  'zh-CN': {
    title: '待办事项',
    input: '新待办',
    add: '添加',
    loading: '加载中…',
    saving: '保存中…',
    empty: '暂无待办。',
    retry: '刷新',
    failed: '请求失败',
    check: '查询操作',
    approval: '请在宿主审批页批准，然后查询此操作。',
  },
}
const h = React.createElement

export function apply(ctx, config) {
  function TodoPage() {
    const locale = React.useSyncExternalStore(ctx.locale.subscribe, () => ctx.locale.locale)
    const t = strings[locale] ?? strings.en
    const [items, setItems] = React.useState([])
    const [text, setText] = React.useState('')
    const [busy, setBusy] = React.useState(true)
    const [error, setError] = React.useState('')
    const [operation, setOperation] = React.useState(null)
    const live = React.useRef(false)
    const locked = React.useRef(false)
    const load = React.useCallback(async () => {
      const result = await ctx.profile.services.query('__SERVICE_NAME__.list', {})
      if (live.current) setItems(result.items)
    }, [])
    const request = React.useCallback(async (work) => {
      if (locked.current) return
      locked.current = true
      setBusy(true)
      setError('')
      try {
        await work()
      } catch (error) {
        if (live.current) setError(error instanceof Error ? error.message : 'Request failed / 请求失败')
      } finally {
        locked.current = false
        if (live.current) setBusy(false)
      }
    }, [])
    React.useEffect(() => {
      live.current = true
      void request(load)
      return () => {
        live.current = false
      }
    }, [load, request])
    async function receipt(result) {
      if (!live.current) return
      if (result.state === 'completed') {
        setOperation(null)
        setText('')
        await load()
      } else {
        if (result.state === 'refused' || result.state === 'cancelled') setOperation(null)
        // Do not repeat an uncertain mutation with a new id. Retain it for read/reconciliation.
        setError(result.state === 'approval-required' ? t.approval : `${t.failed}: ${result.state}`)
      }
    }
    function change(input) {
      if (locked.current) return
      const next = { operationId: crypto.randomUUID(), input }
      setOperation(next)
      return request(async () =>
        receipt(
          await ctx.profile.services.effect('__SERVICE_NAME__.change', input, {
            operationId: next.operationId,
          }),
        ),
      )
    }
    const blocked = busy || operation !== null
    return h(
      'section',
      { 'aria-label': t.title },
      h('h1', null, config.publicConfig?.label ?? t.title),
      busy && h('p', { role: 'status' }, items.length ? t.saving : t.loading),
      error && h('p', { role: 'alert' }, error),
      h(
        'form',
        {
          onSubmit(event) {
            event.preventDefault()
            if (!blocked && text.trim()) void change({ action: 'add', text })
          },
        },
        h(
          'label',
          null,
          t.input,
          h('input', {
            value: text,
            maxLength: 200,
            disabled: blocked,
            onInput: (event) => setText(event.currentTarget.value),
          }),
        ),
        h('button', { type: 'submit', disabled: blocked || !text.trim() }, t.add),
      ),
      h(
        'ul',
        null,
        ...items.map((item) =>
          h(
            'li',
            { key: item.id },
            h(
              'label',
              null,
              h('input', {
                type: 'checkbox',
                checked: item.done,
                disabled: blocked,
                onChange: () => {
                  if (!blocked) void change({ action: 'toggle', id: item.id })
                },
              }),
              item.text,
            ),
          ),
        ),
      ),
      !busy && !items.length && h('p', null, t.empty),
      h(
        'button',
        {
          type: 'button',
          disabled: busy,
          onClick: () => {
            void request(load)
          },
        },
        t.retry,
      ),
      operation &&
        h(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick: () => {
              void request(async () => {
                let result = await ctx.profile.services.readOperation(
                  '__SERVICE_NAME__.change',
                  operation.operationId,
                )
                if (result.state === 'approval-required')
                  result = await ctx.profile.services.effect('__SERVICE_NAME__.change', operation.input, {
                    operationId: operation.operationId,
                  })
                await receipt(result)
              })
            },
          },
          t.check,
        ),
    )
  }
  ctx.homeEntries.register({
    id: '__SKILL_NAME__',
    icon: 'plugin',
    titleKey: '__PACKAGE_NAME__',
    order: 50,
    placement: 'secondary',
    component: TodoPage,
  })
}
