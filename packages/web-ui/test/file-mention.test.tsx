/** @vitest-environment happy-dom */
import type { UINode } from '@agnes/protocol'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserMessage, withFileMentions, withSkillMentions } from '../src/conversation/messages/user-message.js'
import {
  fileMentionBlock,
  fileMentionIcon,
  fileMentionLinks,
  fileMentionOf,
  fileMentionPath,
  fileMentionUri,
  mountRegion,
} from '../src/index.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})

describe('file mention links', () => {
  it('carries the real absolute path as a file URI, both ways', () => {
    for (const path of [
      '/work/Work LLM/bootlab-new.html',
      '/tmp/报告 #1.md',
      'C:/work/a b.txt',
      '/repo/a\\b',
      '/repo/%5C#中文',
      '//server/share/中文 a',
    ]) {
      expect(fileMentionPath(fileMentionUri(path)), path).toBe(path)
    }
    expect(fileMentionUri('/work/Work LLM/a.html')).toBe('file:///work/Work%20LLM/a.html')
    expect(fileMentionUri('C:\\work\\a.txt')).toBe('file:///C:/work/a.txt')
    expect(fileMentionPath(fileMentionUri('\\\\server\\share\\a.txt'))).toBe('//server/share/a.txt')
    expect(fileMentionUri('/repo/a\\b')).toBe('file:///repo/a%5Cb')
    expect(fileMentionPath('agnes-upload://x')).toBeUndefined()
  })

  it('reads a mention only from a file link, and a folder from its MIME type', () => {
    const file = { path: '/w/index.html', name: 'index.html', directory: false }
    const folder = { path: '/w/src', name: 'src', directory: true }
    expect(fileMentionOf(fileMentionBlock(file))).toEqual(file)
    expect(fileMentionOf(fileMentionBlock(folder))).toEqual(folder)
    expect(fileMentionBlock(folder).mimeType).toBe('inode/directory')
    expect(fileMentionOf({ type: 'resource_link', uri: 'agnes-upload://a/b/1/c', name: 'x' })).toBeUndefined()
    expect(fileMentionOf({ type: 'text' })).toBeUndefined()
    expect([
      fileMentionIcon('a.ts', false),
      fileMentionIcon('a.md', false),
      fileMentionIcon('a.bin', false),
    ]).toEqual(['file-code', 'file-text', 'file'])
    expect(fileMentionIcon('src', true)).toBe('folder')
  })
})

describe('file chips in a sent message', () => {
  const index = { path: '/w/site/index.html', name: 'index.html', directory: false }
  const other = { path: '/w/old/index.html', name: 'index.html', directory: false }

  it('places each file where its @name stands, longest name first', () => {
    const { parts, unplaced } = withFileMentions('看 @index.html 和 @old/index.html。', [index, other])
    expect(parts).toEqual(['看 ', index, ' 和 ', other, '。'])
    expect(unplaced).toEqual([])
    // A file the text does not name still shows, ahead of the text.
    expect(withFileMentions('看一下', [index]).unplaced).toEqual([index])
  })

  it('renders chips with the full path on hover and opens the file in the workbench on click', () => {
    const opened = vi.fn(() => true)
    const unregister = fileMentionLinks.register(opened)
    cleanups.push(unregister)
    const node = {
      kind: 'user',
      id: 'u1',
      content: [
        { type: 'text', text: '解释 @index.html 里面的结构' },
        { type: 'resource_link', uri: 'file:///w/site/index.html', name: 'index.html' },
      ],
    } as unknown as Extract<UINode, { kind: 'user' }>
    const host = document.createElement('div')
    document.body.append(host)
    cleanups.push(
      mountRegion(host, createElement(UserMessage, { node, t: (key, vars) => `${key}:${vars?.name ?? ''}` })),
    )
    const body = host.querySelector('.node-body')
    expect(body?.textContent).toBe('解释 index.html 里面的结构')
    const chip = body?.querySelector<HTMLButtonElement>('[data-testid="file-mention-chip"]')
    expect(chip?.title).toBe('/w/site/index.html')
    expect(chip?.getAttribute('aria-label')).toBe('usermessage.openFile:index.html')
    expect(chip?.querySelector('svg')).toBeTruthy()
    chip?.click()
    expect(opened).toHaveBeenCalledWith(index)
  })
})

describe('skill chips in a sent message', () => {
  it('keeps the explicit skill text in the copy while rendering its sparkle marker', () => {
    expect(withSkillMentions('请用 $review-notes，然后继续。')).toEqual([
      '请用 ',
      { kind: 'skill', name: 'review-notes' },
      '，然后继续。',
    ])
    const node = {
      kind: 'user',
      id: 'u1',
      content: [{ type: 'text', text: '$想法可行性速评' }],
    } as unknown as Extract<UINode, { kind: 'user' }>
    const host = document.createElement('div')
    document.body.append(host)
    cleanups.push(mountRegion(host, createElement(UserMessage, { node, t: (key) => key })))
    const chip = host.querySelector<HTMLElement>('[data-testid="skill-mention-chip"]')
    expect(chip?.textContent).toContain('想法可行性速评')
    expect(chip?.textContent).not.toContain('$想法可行性速评')
    expect(chip?.querySelector('svg')).toBeTruthy()
  })
})
