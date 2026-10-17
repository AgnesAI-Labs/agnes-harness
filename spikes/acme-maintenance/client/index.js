import { createElement as h, useState, useSyncExternalStore } from 'react'
import { homeNavigation, SlotOutlet } from '@agnes/web-client'

export function apply(ctx, config) {
  ctx.effect(() => ctx.locale.register('acme-maintenance', {
    en: { 'acme.name': 'Acme Maintenance', 'acme.home': 'Maintenance home', 'acme.conversation': 'Conversation', 'acme.start': 'Start maintenance agent', 'acme.copy': 'One agent · one synthetic asset · read-only inspection', 'acme.language': 'Language', 'acme.running': 'Running inspection…', 'acme.noWorkspace': 'No registered workspace', 'acme.prompt': 'Inspect synthetic asset ACME-001' },
    'zh-CN': { 'acme.name': 'Acme 维保平台', 'acme.home': '维保首页', 'acme.conversation': '对话', 'acme.start': '启动维保智能体', 'acme.copy': '一个智能体 · 一台合成设备 · 只读巡检', 'acme.language': '语言', 'acme.running': '正在巡检…', 'acme.noWorkspace': '没有已登记的工作区', 'acme.prompt': '巡检合成设备 ACME-001' },
  }))
  function useText() {
    useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getSnapshot)
    return (key) => ctx.locale.t(`acme.${key}`)
  }
  function Mark() { return h('strong', { className: 'acme-mark', 'aria-label': 'Acme' }, 'A') }
  function Brand() { const t = useText(); return h('span', null, t('name')) }
  function Sidebar() {
    const t = useText()
    return h('div', { className: 'acme-sidebar' },
      h('div', { className: 'acme-lockup' }, h(SlotOutlet, { name: 'sidebar.brand.mark' }), h(SlotOutlet, { name: 'sidebar.brand.name' })),
      h('nav', { 'aria-label': 'Acme' },
        h('button', { onClick: () => homeNavigation.open('acme-home') }, t('home')),
        h('button', { onClick: () => homeNavigation.close() }, t('conversation'))),
      h('small', null, `v${config.publicConfig.version}`),
      // Settings is the host-owned locale preference/persistence UI. No direct preference writes.
      h('a', { href: '?settings=general' }, t('language')))
  }
  function Home() {
    const t = useText()
    const [state, setState] = useState('')
    async function start() {
      setState(t('running'))
      try {
        const { items: workspaces } = await ctx.agnes.workspace.list()
        if (!workspaces.length) throw new Error(t('noWorkspace'))
        const session = await ctx.agnes.session.new({ cwd: workspaces[0].path, bundles: ['acme-maintenance#maintenance'], preset: 'acme-maintenance', sessionKey: crypto.randomUUID() })
        await session.attach()
        const result = await session.prompt(t('prompt'))
        if (result.reason !== 'completed') throw new Error(result.reason)
        const url = new URL(location.href)
        url.searchParams.delete('page')
        url.searchParams.delete('settings')
        url.searchParams.set('session', session.id)
        location.assign(url.href)
      } catch (error) { setState(String(error)) }
    }
    return h('section', { className: 'acme-home', 'data-testid': 'acme-home' },
      h(Mark), h('h1', null, t('name')), h('h2', null, t('home')), h('p', null, t('copy')),
      h('button', { onClick: start, disabled: state === t('running') }, t('start')),
      h('p', { role: 'status' }, state))
  }
  function Hero() { const t = useText(); return h('div', { className: 'acme-hero' }, h(SlotOutlet, { name: 'conversation.hero.brand.mark' }), h('h1', null, t('name'))) }
  ctx.presentationRoles.register({ role: 'acme.application', priority: -10, mount() {
    const stops = [
      ctx.homeEntries.register({ id: 'acme-home', placement: 'primary', order: -10, icon: 'bot', titleKey: 'acme.home', component: Home }),
      ...[['sidebar.brand.mark', Mark], ['sidebar.brand.name', Brand], ['conversation.hero.brand.mark', Mark], ['ui:sidebar', Sidebar], ['ui:empty-state', Hero]].map(([name, component]) => ctx.slots.register({ name, id: `acme-${name.replaceAll(':', '-').replaceAll('.', '-')}`, priority: -10 }, component)),
    ]
    // Intentional presentation choice; does not confer backend authorization.
    if (!new URL(location.href).searchParams.has('session') && !new URL(location.href).searchParams.has('settings') && !homeNavigation.getSnapshot()) homeNavigation.open('acme-home')
    return () => { for (const stop of stops.reverse()) stop() }
  } })
}
