/** @vitest-environment happy-dom */

import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { CONVERSATION_SLOT } from '../src/region-slots.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

describe('rendered conversation region', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
  })

  it('renders the outer component boundary with all existing child region mounts', async () => {
    runtime = await mountRenderedIndex()
    const conversation = document.querySelector('#conversation-shell')
    expect(conversation?.querySelector('[data-slot="ui:conversation"]')).toBeTruthy()
    expect(conversation?.querySelector('[data-slot="ui:transcript"] #transcript-content')).toBeTruthy()
    expect(conversation?.querySelector('[data-slot="ui:empty-state"] #empty-state-title')).toBeTruthy()
    expect(conversation?.querySelector('#new-content')).toBeInstanceOf(HTMLButtonElement)
    expect(document.querySelector('[data-slot="ui:approval"] #approval-content')).toBeTruthy()
    expect(document.querySelector('[data-slot="ui:composer"] #prompt')).toBeTruthy()
  })

  it('shadows only the conversation boundary and restores child mounts after unload', async () => {
    runtime = await mountRenderedIndex()
    const conversation = document.querySelector('#conversation-shell')
    const remove = runtime.registry.register(
      {
        name: CONVERSATION_SLOT as string,
        id: 'fixture-conversation-shadow',
        owner: 'fixture',
        priority: -1,
      },
      () => createElement('div', { id: 'shadow-conversation' }, '替换对话容器'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(conversation?.querySelector('#shadow-conversation')?.textContent).toBe('替换对话容器')
    expect(conversation?.querySelector('#transcript')).toBeNull()
    expect(conversation?.querySelector('#empty-state')).toBeNull()
    expect(document.querySelector('[data-slot="ui:approval"] #approval-content')).toBeTruthy()
    expect(document.querySelector('[data-slot="ui:composer"] #prompt')).toBeTruthy()

    remove()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(conversation?.querySelector('#shadow-conversation')).toBeNull()
    expect(conversation?.querySelector('[data-slot="ui:transcript"] #transcript-content')).toBeTruthy()
    expect(conversation?.querySelector('[data-slot="ui:empty-state"] #empty-state-title')).toBeTruthy()
  })

  it('mounts session header child outlets only after a session becomes available', async () => {
    runtime = await mountRenderedIndex()
    runtime.session.setSession('session-header-1')
    const remove = runtime.registry.register(
      {
        name: 'conversation.session.header.actions',
        id: 'fixture-session-header-action',
        owner: 'fixture',
      },
      ({ owner }: { owner: { sessionId: string } }) =>
        createElement(
          'button',
          { id: 'fixture-session-header-action-button', type: 'button' },
          owner.sessionId,
        ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(document.querySelector('.conversation-session-header')).toBeTruthy()
    expect(document.querySelector('#fixture-session-header-action-button')?.textContent).toBe(
      'session-header-1',
    )
    remove()
  })
})
