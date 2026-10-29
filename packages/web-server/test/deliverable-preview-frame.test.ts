import { expect, it } from 'vitest'
import { deliverablePreviewFrame } from '../src/deliverable-preview-frame.js'

it('serves an opaque-origin document that can run a page but reach nothing', () => {
  const { csp, body } = deliverablePreviewFrame()
  const directives = Object.fromEntries(
    csp.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/)
      return [name, values.join(' ')]
    }),
  )
  // Scripts run, but the document never shares the workbench's origin.
  expect(directives.sandbox).toBe('allow-scripts')
  expect(csp).not.toContain('allow-same-origin')
  expect(csp).not.toContain('allow-top-navigation')
  expect(directives['default-src']).toBe("'none'")
  // No network: nothing can be fetched or posted, and only bytes the page carries can be shown.
  expect(directives['connect-src']).toBe("'none'")
  expect(directives['form-action']).toBe("'none'")
  expect(directives['frame-src']).toBe("'none'")
  expect(directives['img-src']).toBe('data: blob:')
  for (const value of Object.values(directives)) expect(value).not.toMatch(/https?:|\*|'self'/)
  // The frame carries no deliverable; it waits for one message from its embedder.
  expect(body).toContain("event.source !== parent || event.data?.type !== 'agnes-preview-html'")
  expect(body).toContain("parent.postMessage({ type: 'agnes-preview-ready' }, '*')")
})
