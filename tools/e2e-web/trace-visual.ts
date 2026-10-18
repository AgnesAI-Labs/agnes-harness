import type { Page } from '@playwright/test'

/** Normalize only runtime clocks and isolated paths; keep records, controls and statuses visible. */
export async function normalizeTraceVisual(page: Page) {
  const fields = page.locator(
    '.trace-stat, .trace-stat b, .trace-turn-meta, .trace-row-duration, .trace-row-text, .trace-inspector-meta > span, .trace-fact dd',
  )
  await fields.evaluateAll((nodes) => {
    for (const node of nodes) {
      if (node.childElementCount) continue
      const original = node.textContent ?? ''
      const context = node.matches('.trace-row-text')
      if (context && !node.closest('.trace-row')?.querySelector('.kind-context')) continue
      const text = context
        ? original
            .replace(/(?:\/private)?\/tmp\/agh-e2e-[^/\s]+\/w/g, '/workspace/w')
            .replace(/(Current time:).*?(?=\s+Time zone:|$)/, '$1 2026-10-19 12:00 UTC')
            .replace(/(Elapsed since the preceding turn ended:)\s+\d+ seconds/, '$1 0 seconds')
        : original
            .replace(/\d+(?:\.\d+)? ?(ms|s|毫秒|秒)(?=\s|$|[·,)])/g, '0 $1')
            .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?: ?[AP]M)?\b/g, '12:00')
      if (text === original) continue
      node.setAttribute('data-e2e-trace-original', original)
      node.textContent = text
    }
  })
  return () =>
    page.locator('[data-e2e-trace-original]').evaluateAll((nodes) => {
      for (const node of nodes) {
        node.textContent = node.getAttribute('data-e2e-trace-original')
        node.removeAttribute('data-e2e-trace-original')
      }
    })
}
