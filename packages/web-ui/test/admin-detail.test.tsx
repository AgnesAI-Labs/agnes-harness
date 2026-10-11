/** @vitest-environment happy-dom */
import type { PackageOperation } from '@agnes/protocol'
import { act, createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { DetailContent, mountRegion } from '../src/index.js'

let dispose: () => void = () => undefined
afterEach(async () => {
  await act(async () => dispose())
  document.body.replaceChildren()
})

describe('admin detail', () => {
  it('localizes fixed controls and preserves accessible action hooks with primitive styling', async () => {
    const operation = {
      operationId: 'operation-1',
      operation: 'enable',
      state: 'completed',
      retryable: true,
    } as unknown as PackageOperation
    const host = document.createElement('div')
    document.body.append(host)
    dispose = mountRegion(
      host,
      createElement(DetailContent, {
        heading: 'acme/demo',
        intro: 'Package details',
        version: '1.0.0',
        stateText: undefined,
        facts: [],
        blockerSections: [],
        operations: [{ operation, canCancel: true }],
        lastOperationLabel: 'Enable: Completed',
        actions: [
          {
            label: 'Publish',
            className: 'primary-button publish-hook',
            ariaLabel: 'Publish reviewed plugin',
            title: 'Reviewed content only',
            onClick: () => undefined,
          },
          {
            label: 'Open surface',
            className: 'secondary-button compact surface-hook',
            href: '/surface',
            ariaLabel: 'Open registered surface',
            onClick: () => undefined,
          },
          {
            label: 'Remove',
            className: 'danger-button remove-hook',
            ariaLabel: 'Remove reviewed plugin',
            title: 'Remove after confirmation',
            onClick: () => undefined,
          },
        ],
        onClose: () => undefined,
        onCancelOperation: () => undefined,
      }),
    )
    const text = host.textContent ?? ''

    expect(host.querySelector('.plugin-detail-close')?.getAttribute('aria-label')).toBe(
      'Close acme/demo details',
    )
    expect(host.querySelector('.plugin-detail-close svg')).not.toBeNull()
    expect(text).toContain('Recently completed operations')
    expect(text).toContain('Ongoing operations')
    expect(text).toContain('Enable: Completed · Backend allows retry')
    expect(text).toContain('Request cancellation')
    expect(host.querySelector('.publish-hook')?.getAttribute('aria-label')).toBe('Publish reviewed plugin')
    expect(host.querySelector('.publish-hook')?.getAttribute('title')).toBe('Reviewed content only')
    expect(host.querySelector('.surface-hook')?.getAttribute('href')).toBe('/surface')
    const menu = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Actions',
    )
    await act(async () => menu?.click())
    expect(document.querySelector('.remove-hook')?.getAttribute('role')).toBe('menuitem')
    expect(document.querySelector('.remove-hook')?.getAttribute('aria-label')).toBe('Remove reviewed plugin')
    expect(document.querySelector('.remove-hook')?.getAttribute('title')).toBe('Remove after confirmation')
    expect(
      host.querySelectorAll('.primary-button, .secondary-button, .danger-button, .compact'),
    ).toHaveLength(0)
  })
})
