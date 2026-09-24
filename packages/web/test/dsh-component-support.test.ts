/** @vitest-environment happy-dom */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { UINode } from '@agnes/protocol'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTimelineRenderer } from '../src/timeline.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

describe('DSH component support matrix', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
  })

  it('mounts representative sidebar, settings, rightbar, header, composer, chat and tool hosts', async () => {
    runtime = await mountRenderedIndex()
    const removeSidebar = runtime.registry.register(
      { name: 'sidebar.brand.name', id: 'dsh-support-sidebar', owner: 'fixture' },
      () => createElement('span', { id: 'dsh-support-sidebar-content' }, '品牌扩展'),
    )
    const removeSettings = runtime.registry.register(
      { name: 'settings.header', id: 'dsh-support-settings', owner: 'fixture' },
      () => createElement('span', { id: 'dsh-support-settings-content' }, '设置扩展'),
    )
    const removeRightbar = runtime.registry.register(
      { name: 'rightbar.session', id: 'dsh-support-rightbar', owner: 'fixture', priority: -1 },
      () => createElement('span', { id: 'dsh-support-rightbar-content' }, '右栏扩展'),
    )
    const removeHeader = runtime.registry.register(
      { name: 'conversation.session.header.actions', id: 'dsh-support-header', owner: 'fixture' },
      ({ owner }: { owner: { sessionId: string } }) =>
        createElement('span', { id: 'dsh-support-header-content' }, owner.sessionId),
    )
    const removeComposer = runtime.registry.register(
      { name: 'conversation.input.model', id: 'dsh-support-composer', owner: 'fixture' },
      () => createElement('span', { id: 'dsh-support-composer-content' }, '模型扩展'),
    )
    const removeChat = runtime.registry.register(
      {
        name: 'conversation.chat.node',
        key: 'assistant',
        id: 'dsh-support-chat',
        owner: 'fixture',
        priority: -1,
      },
      ({ owner }: { owner: { node: UINode } }) =>
        createElement('span', { id: 'dsh-support-chat-content' }, owner.node.id),
    )
    const removeTool = runtime.registry.register(
      { name: 'tool.call.toolview', key: 'bash', id: 'dsh-support-tool', owner: 'fixture', priority: -1 },
      ({ owner }: { owner: { callId: string } }) =>
        createElement('span', { id: 'dsh-support-tool-content' }, owner.callId),
    )

    runtime.session.setSession('dsh-session')
    const dshTranscript = document.createElement('div')
    const newContentButton = document.createElement('button')
    document.body.append(dshTranscript, newContentButton)
    const timeline = createTimelineRenderer({
      transcript: dshTranscript,
      newContentButton,
      registry: runtime.registry,
      session: runtime.session,
    })
    timeline.render([
      { kind: 'assistant', id: 'assistant-dsh', seq: 1, text: 'assistant' },
      {
        kind: 'tool',
        id: 'tool-dsh',
        seq: 2,
        toolUseId: 'call-dsh',
        name: 'bash',
        status: 'completed',
        summary: 'bash',
      },
    ])
    // Every outlet mounts through a React root, so they settle asynchronously; a fixed sleep races
    // with the render under parallel test load.
    await vi.waitFor(() => {
      expect(document.querySelector('#dsh-support-sidebar-content')).toBeTruthy()
      expect(document.querySelector('#dsh-support-settings-content')).toBeTruthy()
      expect(document.querySelector('#dsh-support-rightbar-content')).toBeTruthy()
      expect(document.querySelector('#dsh-support-header-content')?.textContent).toBe('dsh-session')
      expect(document.querySelector('#dsh-support-composer-content')).toBeTruthy()
      expect(dshTranscript.querySelector('#dsh-support-chat-content')?.textContent).toBe('assistant-dsh')
      expect(dshTranscript.querySelector('#dsh-support-tool-content')?.textContent).toBe('call-dsh')
    })

    timeline.dispose?.()
    removeTool()
    removeChat()
    removeComposer()
    removeHeader()
    removeRightbar()
    removeSettings()
    removeSidebar()
  })

  it('keeps the opt-in browser acceptance harness deterministic without Playwright', () => {
    const repoRoot = resolve(
      process.cwd().endsWith('/packages/web') ? process.cwd() : resolve(process.cwd(), 'packages/web'),
      '../..',
    )
    const output = execFileSync(
      process.execPath,
      [resolve(repoRoot, 'tools/acceptance/web-dsh-component-slots.mjs'), '--self-test'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    expect(output).toContain('SELF-TEST PASS 7 host surfaces; 3 plugin surfaces')
    expect(output).toContain('READY-SELF-TEST PASS body and conversation header')
  })
})
