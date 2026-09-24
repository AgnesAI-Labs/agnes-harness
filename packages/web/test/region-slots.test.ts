/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { UINode } from '@agnes/protocol'
import { ClientResourceService, SessionService, SlotRegistry } from '@agnes/web-client'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APPROVAL_SLOT,
  CONVERSATION_SLOT,
  EMPTY_STATE_SLOT,
  mountApprovalRegion,
  mountConversationRegion,
  mountDshShellRegion,
  mountEmptyStateRegion,
  mountRightbarRegion,
  mountSettingsPaneRegion,
  mountSidebarRegion,
  mountTopbarRegion,
  mountTraceRegion,
  mountTranscriptRegion,
  SIDEBAR_SLOT,
  settingsPaneSlot,
  TOPBAR_SLOT,
  TRACE_SLOT,
  TRANSCRIPT_SLOT,
} from '../src/region-slots.js'

const mounts: Array<ReturnType<typeof mountEmptyStateRegion>> = []
const contexts: Context[] = []

async function registry(): Promise<SlotRegistry> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SlotRegistry)
  return (ctx as unknown as { slots: SlotRegistry }).slots
}

afterEach(async () => {
  while (mounts.length) mounts.pop()?.dispose()
  while (contexts.length) await contexts.pop()?.fiber.dispose()
  document.body.replaceChildren()
})

describe('DSH top-level shell', () => {
  it('bridges main/conversation and exposes the root overlay host', async () => {
    const slots = await registry()
    const shell = mountDshShellRegion(slots)
    mounts.push(shell)
    const conversation = document.createElement('div')
    document.body.append(conversation)
    mounts.push(mountConversationRegion(slots, conversation))
    const remove = slots.register(
      { name: 'shell.overlay', id: 'fixture-shell-overlay', owner: 'fixture' },
      () => createElement('button', { id: 'fixture-shell-overlay-content', type: 'button' }, '全局浮层'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(slots.spec('main')).toMatchObject({ kind: 'keyed', scope: 'root' })
    expect(slots.spec('main.conversation')).toMatchObject({ kind: 'single', scope: 'session-maybe' })
    expect(slots.spec('conversation.composer')).toMatchObject({ kind: 'chain', scope: 'session' })
    expect(slots.spec('conversation.composer.bar')).toMatchObject({
      kind: 'single',
      scope: 'session-maybe',
    })
    expect(conversation.querySelector('[data-slot="main"] #empty-state')).toBeTruthy()
    expect(
      document.querySelector('[data-agnes-dsh-shell-overlay] #fixture-shell-overlay-content'),
    ).toBeTruthy()
    remove()
  })
})

describe('migrated empty-state region', () => {
  it('replaces the legacy children with one SlotOutlet-backed built-in unit', async () => {
    const slots = await registry()
    const section = document.createElement('section')
    section.id = 'empty-state'
    section.innerHTML = '<h2>legacy duplicate</h2>'
    document.body.append(section)

    mounts.push(mountEmptyStateRegion(slots, section))
    expect(section.textContent).not.toContain('legacy duplicate')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(section.querySelector('[data-slot="ui:empty-state"]')).toBeTruthy()
    expect(section.querySelector('[data-agnes-region-unit="empty-state"]')).toBeTruthy()
    expect(section.querySelector('#empty-state-title')?.textContent).toBe('Agnes Harness')
  })

  it('allows a lower-priority replaceable unit without changing the outer section', async () => {
    const slots = await registry()
    const section = document.createElement('section')
    section.id = 'empty-state'
    document.body.append(section)
    mounts.push(mountEmptyStateRegion(slots, section))
    const remove = slots.register(
      { name: EMPTY_STATE_SLOT as string, id: 'plugin-empty-state', owner: 'fixture', priority: -1 },
      () => createElement('div', { 'data-fixture-unit': 'replacement' }, '替换空态'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(section.id).toBe('empty-state')
    expect(section.textContent).toContain('替换空态')
    expect(section.textContent).not.toContain('Agnes Harness')
    remove()
  })

  it('mounts conversation hero child outlets inside the existing empty-state unit', async () => {
    const slots = await registry()
    const section = document.createElement('section')
    section.id = 'empty-state'
    document.body.append(section)
    mounts.push(mountEmptyStateRegion(slots, section))
    const remove = slots.register(
      { name: 'conversation.hero.workspace', id: 'fixture-hero-workspace', owner: 'fixture' },
      () => createElement('button', { id: 'fixture-hero-workspace', type: 'button' }, '选择工作区'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(section.querySelector('[data-agnes-conversation-hero] #fixture-hero-workspace')).toBeTruthy()
    expect(section.querySelector('#empty-state-title')?.textContent).toBe('Agnes Harness')
    remove()
  })
})

describe('migrated sidebar region', () => {
  it('renders component-owned controls behind a replaceable SlotOutlet', async () => {
    const slots = await registry()
    const sidebar = document.createElement('aside')
    sidebar.className = 'sidebar'
    sidebar.innerHTML =
      '<button id="new">新会话</button><nav id="sessions"></nav><button id="settings">设置</button>'
    document.body.append(sidebar)
    mounts.push(mountSidebarRegion(slots, sidebar))

    expect(sidebar.querySelector('[data-slot="ui:sidebar"]')).toBeTruthy()
    expect(sidebar.querySelector('#new')?.textContent).toBe('新会话')
    const remove = slots.register(
      { name: SIDEBAR_SLOT as string, id: 'plugin-sidebar', owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'replacement-sidebar' }, '替换侧栏'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sidebar.querySelector('#replacement-sidebar')).toBeTruthy()
    expect(sidebar.querySelector('#new')).toBeNull()
    remove()
  })

  it('declares and renders the first DSH sidebar child slots without replacing the shell', async () => {
    const slots = await registry()
    const sidebar = document.createElement('aside')
    sidebar.className = 'sidebar'
    document.body.append(sidebar)
    mounts.push(mountSidebarRegion(slots, sidebar))

    const remove = slots.register(
      { name: 'sidebar.footer.action', id: 'fixture-footer-action', owner: 'fixture' },
      () => createElement('button', { id: 'fixture-sidebar-action', type: 'button' }, '扩展动作'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(sidebar.querySelector('#new')).toBeTruthy()
    expect(sidebar.querySelector('#fixture-sidebar-action')?.textContent).toBe('扩展动作')
    expect(sidebar.querySelector('#fixture-sidebar-action')?.closest('.sidebar-footer')).toBeTruthy()
    expect(slots.entriesByOwner('fixture').map((entry) => entry.name)).toEqual(['sidebar.footer.action'])
    remove()
  })

  it('keeps the workspace directory flow as a nested DSH outlet', async () => {
    const slots = await registry()
    const sidebar = document.createElement('aside')
    sidebar.className = 'sidebar'
    document.body.append(sidebar)
    mounts.push(mountSidebarRegion(slots, sidebar))

    const remove = slots.register(
      { name: 'sidebar.workspaces.directoryFlow', id: 'fixture-directory-flow', owner: 'fixture' },
      () => createElement('span', { id: 'fixture-directory-flow-content' }, '目录流程'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(
      sidebar.querySelector('#fixture-directory-flow-content')?.closest('.sidebar-section-heading'),
    ).toBeTruthy()
    remove()
  })
})

describe('migrated transcript region', () => {
  it('gives the component-owned timeline one stable leaf inside a replaceable SlotOutlet', async () => {
    const slots = await registry()
    const transcript = document.createElement('section')
    transcript.id = 'transcript'
    document.body.append(transcript)
    const newContentButton = document.createElement('button')
    document.body.append(newContentButton)
    const mount = mountTranscriptRegion(slots, transcript, { newContentButton })
    mounts.push(mount)
    const content = transcript.querySelector('#transcript-content')
    expect(content?.closest('[data-slot]')?.getAttribute('data-slot')).toBe('ui:transcript')
    const node: UINode = { kind: 'assistant', id: 'assistant-1', seq: 1, text: 'timeline item' }
    mount.render([node])
    expect(content?.querySelector('[data-node-id="assistant-1"]')?.textContent).toContain('timeline item')
    mount.render([node], [], { hasEarlier: true, loadEarlier: () => undefined })
    expect(transcript.querySelector<HTMLElement>('.transcript-earlier')?.hidden).toBe(false)
    const remove = slots.register(
      { name: TRANSCRIPT_SLOT as string, id: 'plugin-transcript', owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'replacement-transcript' }, '替换时间线'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(transcript.querySelector('#replacement-transcript')).toBeTruthy()
    expect(transcript.querySelector('#transcript-content')).toBeNull()
    remove()
  })

  it('declares transcript child slots and renders them beside the native fallback', async () => {
    const slots = await registry()
    slots.setSession('session-a')
    const transcript = document.createElement('section')
    const newContentButton = document.createElement('button')
    document.body.append(transcript, newContentButton)
    const mount = mountTranscriptRegion(slots, transcript, { newContentButton })
    mounts.push(mount)

    const removeActions = slots.register(
      { name: 'conversation.chat.assistant-actions', id: 'fixture-assistant-actions', owner: 'fixture' },
      () => createElement('span', { id: 'fixture-assistant-actions-content' }, '消息动作'),
    )
    const removeCordis = slots.register(
      { name: 'tool.view.cordis', key: 'bash', id: 'fixture-cordis', owner: 'fixture' },
      () => createElement('span', { id: 'fixture-cordis-content' }, 'Cordis 视图'),
    )

    mount.render([
      { kind: 'assistant', id: 'assistant-1', seq: 1, text: '回答' },
      {
        kind: 'tool',
        id: 'tool-1',
        seq: 2,
        toolUseId: 'call-1',
        name: 'bash',
        status: 'completed',
        summary: '执行命令',
        enforcement: { level: 'full', scope: ['file'] },
        children: [],
        slots: [],
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(slots.spec('conversation.chat.assistant-actions')).toMatchObject({
      kind: 'list',
      scope: 'session',
    })
    expect(slots.spec('tool.view.cordis')).toMatchObject({ kind: 'keyed', scope: 'session' })
    expect(transcript.querySelector('#fixture-assistant-actions-content')?.textContent).toBe('消息动作')
    expect(transcript.querySelector('#fixture-cordis-content')?.textContent).toBe('Cordis 视图')
    expect(transcript.querySelector<HTMLElement>('[data-agnes-timeline-native]')?.hidden).toBe(false)

    removeActions()
    removeCordis()
    mount.dispose()
    expect(slots.spec('conversation.chat.assistant-actions')).toBeUndefined()
    expect(slots.spec('tool.view.cordis')).toBeUndefined()
  })
})

describe('migrated settings panes', () => {
  it('mounts six independently owned pane rows and removing one leaves siblings intact', async () => {
    const slots = await registry()
    const config = document.createElement('dialog')
    config.id = 'config'
    document.body.append(config)
    const mount = mountSettingsPaneRegion(slots, config)
    mounts.push(mount)

    expect(config.querySelector('[data-slot="ui:settings-pane.model"]')).toBeTruthy()
    expect(config.querySelector('[data-slot="ui:settings-pane.plugin"]')).toBeTruthy()
    expect(slots.entriesByOwner('@agnes/web-settings-model').map((entry) => entry.name)).toEqual([
      'ui:settings-pane.model',
    ])
    expect(slots.entriesByOwner('@agnes/web-settings-plugins').map((entry) => entry.name)).toEqual([
      'ui:settings-pane.plugin',
    ])

    mount.open('plugin')
    expect(config.querySelector('#plugin-settings-pane')?.hasAttribute('hidden')).toBe(false)
    expect(config.querySelector('#model-settings-pane')?.hasAttribute('hidden')).toBe(true)
    mount.unmountPane('plugin')
    expect(config.querySelector('#plugin-settings-pane')).toBeNull()
    expect(config.querySelector('#model-settings-pane')).toBeTruthy()
    expect(slots.entries(settingsPaneSlot('plugin') as string)).toEqual([])
    expect(slots.entries(settingsPaneSlot('model') as string)).toHaveLength(1)
  })

  it('mounts DSH settings outlets at the existing pane controls', async () => {
    const slots = await registry()
    const config = document.createElement('dialog')
    config.id = 'config'
    document.body.append(config)
    const mount = mountSettingsPaneRegion(slots, config)
    mounts.push(mount)

    const removeHeader = slots.register(
      { name: 'settings.header', id: 'fixture-settings-header', owner: 'fixture' },
      () => createElement('span', { id: 'fixture-settings-header-content' }, '扩展设置头部'),
    )
    const removeFooter = slots.register(
      { name: 'settings.models.footer', id: 'fixture-settings-footer', owner: 'fixture' },
      () => createElement('span', { id: 'fixture-settings-footer-content' }, '扩展模型尾部'),
    )
    const removePluginItem = slots.register(
      {
        name: 'settings.plugin.item',
        id: 'fixture-settings-plugin-item',
        owner: 'fixture',
        key: 'fixture-plugin',
      },
      () => createElement('span', { id: 'fixture-settings-plugin-item-content' }, '扩展插件项'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(
      config.querySelector('#fixture-settings-header-content')?.closest('#settings-dsh-shell-slots'),
    ).toBeTruthy()
    expect(
      config.querySelector('#fixture-settings-footer-content')?.closest('.config-workspace'),
    ).toBeTruthy()
    expect(
      config.querySelector('#fixture-settings-plugin-item-content')?.closest('#plugin-list'),
    ).toBeTruthy()
    expect(config.querySelector('#config-add-account')).toBeTruthy()
    expect(config.querySelector('#installed-tab')).toBeTruthy()
    expect(config.querySelector('#account-dialog')).toBeTruthy()

    mount.unmountPane('plugin')
    expect(config.querySelector('#fixture-settings-plugin-item-content')).toBeNull()
    expect(config.querySelector('#fixture-settings-footer-content')).toBeTruthy()
    removeHeader()
    removeFooter()
    removePluginItem()
  })
})

describe('migrated conversation region', () => {
  it('keeps child region nodes inside a replaceable conversation boundary', async () => {
    const slots = await registry()
    const conversation = document.createElement('div')
    conversation.id = 'conversation-shell'
    conversation.innerHTML = '<p id="legacy-conversation">legacy</p>'
    document.body.append(conversation)
    const mount = mountConversationRegion(slots, conversation)
    mounts.push(mount)
    expect(conversation.querySelector('#legacy-conversation')).toBeNull()
    expect(conversation.querySelector('[data-slot="ui:conversation"]')).toBeTruthy()
    expect(conversation.querySelector('#transcript')).toBeTruthy()
    expect(conversation.querySelector('#empty-state')).toBeTruthy()
    expect(conversation.querySelector('#new-content')).toBeInstanceOf(HTMLButtonElement)
    const remove = slots.register(
      { name: CONVERSATION_SLOT as string, id: 'plugin-conversation', owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'replacement-conversation' }, '替换对话'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(conversation.querySelector('#replacement-conversation')).toBeTruthy()
    expect(conversation.querySelector('#transcript')).toBeNull()
    remove()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(conversation.querySelector('#transcript')).toBeTruthy()
    expect(conversation.querySelector('#empty-state')).toBeTruthy()
  })

  it('exposes the session and session header DSH outlets inside the native conversation shell', async () => {
    const slots = await registry()
    const conversation = document.createElement('div')
    conversation.id = 'conversation-shell'
    document.body.append(conversation)
    mounts.push(mountConversationRegion(slots, conversation))
    slots.setSession('session-1')
    const removeSession = slots.register(
      { name: 'conversation.session', id: 'fixture-conversation-session', owner: 'fixture' },
      () => createElement('span', { id: 'fixture-conversation-session-content' }, '会话扩展'),
    )
    const removeHeader = slots.register(
      { name: 'conversation.session.header', id: 'fixture-conversation-header', owner: 'fixture' },
      () => createElement('span', { id: 'fixture-conversation-header-content' }, '会话头部扩展'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(conversation.querySelector('#fixture-conversation-session-content')).toBeTruthy()
    expect(conversation.querySelector('#fixture-conversation-header-content')).toBeTruthy()
    expect(conversation.querySelector('#transcript')).toBeTruthy()
    removeSession()
    removeHeader()
  })
})

describe('migrated topbar region', () => {
  it('renders component-owned controls behind a replaceable SlotOutlet', async () => {
    const slots = await registry()
    const topbar = document.createElement('header')
    topbar.className = 'topbar'
    topbar.innerHTML = '<p id="legacy-topbar">legacy</p>'
    document.body.append(topbar)
    const mount = mountTopbarRegion(slots, topbar)
    mounts.push(mount)
    expect(topbar.querySelector('#legacy-topbar')).toBeNull()
    expect(topbar.querySelector('[data-slot="ui:topbar"]')).toBeTruthy()
    expect(topbar.querySelector('#sidebar-toggle')).toBeTruthy()
    expect(topbar.querySelector('#task-title')?.textContent).toBe('新会话')
    mount.setTaskTitle('组件标题')
    mount.setStatus('运行中', 'running')
    mount.setConnectionState('connected')
    expect(topbar.querySelector('#task-title')?.textContent).toBe('组件标题')
    expect(topbar.querySelector('#status')?.textContent).toBe('运行中')
    expect(topbar.querySelector<HTMLElement>('#status')?.dataset.state).toBe('running')
    expect(topbar.querySelector('#connection')?.textContent).toBe('本地后台已连接')
    const remove = slots.register(
      { name: TOPBAR_SLOT as string, id: 'plugin-topbar', owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'replacement-topbar' }, '替换顶部栏'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(topbar.querySelector('#replacement-topbar')).toBeTruthy()
    expect(topbar.querySelector('#task-title')).toBeNull()
    remove()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(topbar.querySelector('#task-title')).toBeTruthy()
  })
})

describe('migrated approval region', () => {
  it('renders a component-owned card and keeps action focus across same-key updates', async () => {
    const slots = await registry()
    const approval = document.createElement('section')
    approval.id = 'approval'
    approval.setAttribute('aria-live', 'polite')
    document.body.append(approval)
    const selected: string[] = []
    const mount = mountApprovalRegion(slots, approval)
    mounts.push(mount)
    slots.setSession('session-1')
    const removeDetail = slots.register(
      { name: 'conversation.approval.detail', id: 'fixture-approval-detail', owner: 'fixture' },
      () => createElement('p', { id: 'fixture-approval-detail-content' }, '扩展审批详情'),
    )
    expect(approval.getAttribute('aria-live')).toBe('polite')
    expect(approval.querySelector('#approval-content')).toBeTruthy()
    mount.render({
      key: 'approval-1',
      title: '需要你的确认',
      summary: '允许执行？',
      impact: '可能修改内容',
      preview: '{"path":"README.md"}',
      actions: [
        { id: 'allow', label: '允许', onSelect: () => selected.push('allow') },
        { id: 'reject', label: '拒绝', onSelect: () => selected.push('reject') },
        { id: 'cancel', label: '取消', onSelect: () => selected.push('cancel') },
      ],
      disabled: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(approval.hidden).toBe(false)
    expect(approval.querySelector('h2')?.textContent).toBe('需要你的确认')
    expect(approval.querySelector('pre')?.textContent).toBe('{"path":"README.md"}')
    expect(approval.querySelector('#fixture-approval-detail-content')?.textContent).toBe('扩展审批详情')
    const allow = approval.querySelector<HTMLButtonElement>('button')
    allow?.focus()
    mount.render({
      key: 'approval-1',
      title: '需要你的确认',
      summary: '允许执行？',
      impact: '可能修改内容',
      actions: [
        { id: 'allow', label: '允许', onSelect: () => selected.push('allow') },
        { id: 'reject', label: '拒绝', onSelect: () => selected.push('reject') },
        { id: 'cancel', label: '取消', onSelect: () => selected.push('cancel') },
      ],
      disabled: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const disabledAllow = approval.querySelector<HTMLButtonElement>('button')
    expect(document.activeElement).not.toBe(disabledAllow)
    expect(disabledAllow?.disabled).toBe(true)
    mount.render({
      key: 'approval-1',
      title: '需要你的确认',
      summary: '允许执行？',
      impact: '可能修改内容',
      actions: [
        { id: 'allow', label: '允许', onSelect: () => selected.push('allow') },
        { id: 'reject', label: '拒绝', onSelect: () => selected.push('reject') },
        { id: 'cancel', label: '取消', onSelect: () => selected.push('cancel') },
      ],
      disabled: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const restoredAllow = approval.querySelector<HTMLButtonElement>('button')
    expect(document.activeElement).toBe(restoredAllow)
    approval.querySelectorAll<HTMLButtonElement>('button')[2]?.click()
    expect(selected).toEqual(['cancel'])

    const remove = slots.register(
      { name: APPROVAL_SLOT as string, id: 'plugin-approval', owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'replacement-approval' }, '替换审批'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(approval.querySelector('#replacement-approval')).toBeTruthy()
    expect(approval.querySelector('#approval-content')).toBeNull()
    remove()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(approval.querySelector('#approval-content')).toBeTruthy()
    mount.render(undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(approval.hidden).toBe(true)
    removeDetail()
  })
})

describe('migrated trace region', () => {
  it('owns the trace renderer behind a replaceable slot and restores it after a shadow is removed', async () => {
    const slots = await registry()
    const trace = document.createElement('aside')
    const toggle = document.createElement('button')
    const chat = document.createElement('button')
    const conversation = document.createElement('div')
    trace.id = 'trace-panel'
    toggle.id = 'view-trace'
    chat.id = 'view-chat'
    conversation.id = 'conversation-shell'
    document.body.append(trace, toggle, chat, conversation)
    // The trace unit only renders while open.
    sessionStorage.setItem('agnes.web.tracePanel', 'open')
    const mount = mountTraceRegion(slots, trace, {
      toggle,
      chatToggle: chat,
      conversation,
      store: sessionStorage,
    })
    mounts.push(mount)
    expect(trace.querySelector('[data-slot="ui:trace"]')).toBeTruthy()
    expect(trace.querySelector('#trace-content')).toBeTruthy()
    mount.render([{ kind: 'assistant', id: 'trace-a', seq: 1, text: 'trace content' }])
    expect(trace.textContent).toContain('trace content')
    mount.render([{ kind: 'assistant', id: 'trace-a', seq: 1, text: 'trace content' }], [], {
      hasEarlier: true,
    })
    expect(trace.textContent).toContain('已加载部分')

    const remove = slots.register(
      { name: TRACE_SLOT as string, id: 'plugin-trace', owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'replacement-trace' }, '替换轨迹'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(trace.querySelector('#replacement-trace')).toBeTruthy()
    expect(trace.querySelector('#trace-content')).toBeNull()
    remove()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(trace.querySelector('#trace-content')).toBeTruthy()
  })
})

describe('DSH rightbar region', () => {
  it('keeps the second display surface hidden until a session contribution is live', async () => {
    const slots = await registry()
    const rightbar = document.createElement('aside')
    rightbar.id = 'rightbar-panel'
    document.body.append(rightbar)
    const mount = mountRightbarRegion(slots, rightbar)
    mounts.push(mount)

    expect(rightbar.hidden).toBe(true)
    const remove = slots.register(
      { name: 'rightbar.session', id: 'fixture-rightbar-session', owner: 'fixture' },
      () => createElement('section', { id: 'fixture-rightbar-content' }, '右侧扩展面板'),
    )
    slots.setSession('session-1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rightbar.hidden).toBe(false)
    expect(rightbar.querySelector('#fixture-rightbar-content')?.textContent).toBe('右侧扩展面板')
    expect(rightbar.querySelector('[data-slot="rightbar.session"]')).toBeTruthy()

    remove()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rightbar.hidden).toBe(true)
  })

  it('mounts document and guide child slots with a safe document renderer fallback', async () => {
    const slots = await registry()
    const rightbar = document.createElement('aside')
    document.body.append(rightbar)
    const mount = mountRightbarRegion(slots, rightbar, {
      document: { id: 'doc-1', title: '指南', kind: 'markdown', content: '# 右栏文档' },
    })
    mounts.push(mount)
    slots.setSession('session-1')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(rightbar.hidden).toBe(false)
    expect(rightbar.querySelector('[data-agnes-rightbar-session]')).toBeTruthy()
    expect(rightbar.querySelector('[data-rightbar-tab="document"] h1')?.textContent).toBe('右栏文档')
    expect(slots.spec('sidebar.right.tab.document')).toMatchObject({ kind: 'keyed', scope: 'session' })
    expect(slots.spec('sidebar.right.tab.guide')).toMatchObject({ kind: 'chain', scope: 'session' })

    const remove = slots.register(
      {
        name: 'sidebar.right.tab.document',
        key: 'markdown',
        id: 'fixture-document',
        owner: 'fixture',
        priority: -1,
      },
      ({ owner }: { owner?: { title?: string } }) =>
        createElement('strong', { id: 'fixture-document-renderer' }, owner?.title ?? '替换文档'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rightbar.querySelector('#fixture-document-renderer')?.textContent).toBe('指南')
    remove()
  })

  it('loads an artifact-backed document through the session resource service', async () => {
    const slots = await registry()
    const rightbar = document.createElement('aside')
    document.body.append(rightbar)
    const session = new SessionService(contexts.at(-1) as Context, 'session-1')
    const artifact = { sha256: 'd'.repeat(64), size: 8, mime: 'text/plain' }
    const resources = new ClientResourceService(
      contexts.at(-1) as Context,
      {
        call: async () => ({
          ok: true as const,
          status: 200 as const,
          artifact,
          acceptRanges: 'bytes' as const,
          contentLength: 8,
          etag: `"${artifact.sha256}"`,
          base64: 'RFNILWRvYyE=',
        }),
      } as never,
      session,
    )
    const mount = mountRightbarRegion(slots, rightbar, {
      session,
      resources,
      document: {
        id: 'artifact-doc',
        title: '产物',
        kind: 'text',
        laneId: 'lane-a',
        artifact,
      },
    })
    mounts.push(mount)

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(rightbar.querySelector('pre')?.textContent).toBe('DSH-doc!')
  })

  it('says a screenshot was removed by the retention policy when the daemon answers 410', async () => {
    const slots = await registry()
    const rightbar = document.createElement('aside')
    document.body.append(rightbar)
    const session = new SessionService(contexts.at(-1) as Context, 'session-1')
    const artifact = { sha256: 'e'.repeat(64), size: 8, mime: 'image/png' }
    const resources = new ClientResourceService(
      contexts.at(-1) as Context,
      {
        call: async () => ({ ok: false as const, status: 410 as const, code: 'artifact_reclaimed' }),
      } as never,
      session,
    )
    mounts.push(
      mountRightbarRegion(slots, rightbar, {
        session,
        resources,
        document: { id: 'reclaimed-shot', title: '截图', kind: 'image', laneId: 'lane-a', artifact },
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(rightbar.querySelector('pre')?.textContent).toBe('截图已按保留策略清理')
  })
})
