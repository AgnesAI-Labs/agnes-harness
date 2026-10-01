/** @vitest-environment happy-dom */
import type { PackageOperation } from '@agnes/protocol'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { DetailContent, mountRegion } from '../src/index.js'

afterEach(() => {
  document.body.replaceChildren()
})

describe('admin detail', () => {
  it('localizes fixed detail and operation controls', () => {
    const operation = {
      operationId: 'operation-1',
      operation: 'enable',
      state: 'completed',
      retryable: true,
    } as unknown as PackageOperation
    const host = document.createElement('div')
    document.body.append(host)
    mountRegion(
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
        actions: [],
        onClose: () => undefined,
        onCancelOperation: () => undefined,
      }),
    )
    const text = host.textContent ?? ''

    expect(host.querySelector('.plugin-detail-close')?.getAttribute('aria-label')).toBe(
      'Close acme/demo details',
    )
    expect(text).toContain('Close details')
    expect(text).toContain('Recently completed operations')
    expect(text).toContain('Ongoing operations')
    expect(text).toContain('Enable: Completed · Backend allows retry')
    expect(text).toContain('Request cancellation')
  })
})
