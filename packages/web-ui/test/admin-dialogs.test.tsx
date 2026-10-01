/** @vitest-environment happy-dom */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
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
  it('localizes fixed source dialog labels while preserving supplied field values', () => {
    const host = render(
      createElement(SourceDialogContent, {
        title: 'Check a source',
        intro: 'Review before install.',
        typeOptions: [{ value: 'npm', label: 'npm' }],
        type: 'npm',
        ref_: 'npm:acme/demo@1.0.0',
        placeholder: 'npm:acme/demo@1.0.0',
        error: '',
        busy: false,
        onTypeChange: () => undefined,
        onRefChange: () => undefined,
        onSubmit: () => undefined,
        onCancel: () => undefined,
      }),
    )

    const text = host.textContent ?? ''
    expect(text).toContain('Source type')
    expect(text).toContain('Source reference')
    expect(text).toContain('Check source')
    expect(text).toContain('Cancel')
    expect(host.querySelector<HTMLInputElement>('#source-ref')?.value).toBe('npm:acme/demo@1.0.0')
  })

  it('localizes fixed confirmation labels while preserving caller-supplied copy', () => {
    const host = render(
      createElement(ConfirmDialogContent, {
        title: 'Install demo',
        description: 'The package will remain disabled.',
        facts: undefined,
        actionLabel: 'Confirm install',
        actionDisabled: false,
        onAction: () => undefined,
        onCancel: () => undefined,
      }),
    )

    const text = host.textContent ?? ''
    expect(text).toContain('Confirmation')
    expect(text).toContain('Cancel')
    expect(text).toContain('Confirm install')
  })
})
