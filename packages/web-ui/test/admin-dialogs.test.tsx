/** @vitest-environment happy-dom */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialogContent, mountRegion, SourceDialogContent } from '../src/index.js'

afterEach(() => {
  document.body.replaceChildren()
})

function render(element: ReturnType<typeof createElement>): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  mountRegion(host, element)
  return host
}

describe('admin dialogs', () => {
  it.each([false, true])('localizes source controls and preserves submission while busy=%s', (busy) => {
    const submitted = vi.fn()
    const cancelled = vi.fn()
    const host = render(
      createElement(SourceDialogContent, {
        title: 'Check a source',
        intro: 'Review before install.',
        typeOptions: [{ value: 'npm', label: 'npm' }],
        type: 'npm',
        ref_: 'npm:acme/demo@1.0.0',
        placeholder: 'npm:acme/demo@1.0.0',
        error: '',
        busy,
        onTypeChange: () => undefined,
        onRefChange: () => undefined,
        onSubmit: submitted,
        onCancel: cancelled,
      }),
    )

    const text = host.textContent ?? ''
    expect(text).toContain('Source type')
    expect(text).toContain('Source reference')
    expect(text).toContain(busy ? 'Checking…' : 'Check source')
    expect(text).toContain('Cancel')
    expect(host.querySelector<HTMLInputElement>('#source-ref')?.value).toBe('npm:acme/demo@1.0.0')
    expect(host.querySelector('label[for="source-ref"]')?.textContent).toContain('Source reference')
    expect(host.querySelector('label[for="source-type"]')?.textContent).toContain('Source type')
    host
      .querySelector('#source-ref')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(submitted).toHaveBeenCalledTimes(busy ? 0 : 1)
    host.querySelector<HTMLButtonElement>('#source-cancel')?.click()
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('localizes fixed confirmation labels while preserving caller-supplied copy', () => {
    const action = vi.fn()
    const cancel = vi.fn()
    const host = render(
      createElement(ConfirmDialogContent, {
        title: 'Install demo',
        description: 'The package will remain disabled.',
        facts: undefined,
        actionLabel: 'Confirm install',
        actionDisabled: true,
        onAction: action,
        onCancel: cancel,
      }),
    )

    const text = host.textContent ?? ''
    expect(text).toContain('Confirmation')
    expect(text).toContain('Cancel')
    expect(text).toContain('Confirm install')
    const button = host.querySelector<HTMLButtonElement>('#plugin-confirm-action')
    expect(button?.disabled).toBe(true)
    button?.click()
    expect(action).not.toHaveBeenCalled()
    host.querySelector<HTMLButtonElement>('#plugin-confirm-cancel')?.click()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
