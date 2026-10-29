import { webLocaleCatalog } from '@agnes/web-foundation/locale-catalog'
import { intelligentUiCatalog, webUiLocaleCatalog } from '@agnes/web-ui'
import { webUnitsLocaleCatalog } from '@agnes/web-units/shell'
import { expect } from 'vitest'

const prefixes = new Set([
  ...[webLocaleCatalog, webUiLocaleCatalog, webUnitsLocaleCatalog, intelligentUiCatalog].flatMap((catalog) =>
    Object.keys(catalog.en ?? {}).map((key) => key.split('.')[0]),
  ),
  // These host catalogs have separate entry points; importing their renderers would register UI.
  'workbench',
  'trace',
  'diagnostics',
])

/** Catch missing keys in text, tooltips, field placeholders and accessible names, including joined values. */
export function expectLocalizedDom(root: Element): void {
  const strings: string[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) strings.push(node.textContent ?? '')
  for (const node of [root, ...root.querySelectorAll('*')])
    for (const name of ['aria-label', 'title', 'placeholder', 'alt']) {
      const value = node.getAttribute(name)
      if (value) strings.push(value)
    }
  const raw = strings.flatMap((value) =>
    [...value.matchAll(/\b([a-zA-Z][\w-]*)(?:\.[\w-]+)+\b/g)]
      .filter((match) => prefixes.has(match[1]))
      .map((match) => match[0]),
  )
  expect(raw, 'rendered catalog keys').toEqual([])
}
