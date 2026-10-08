const paths: Readonly<Record<string, string>> = {
  accounts: 'M7 8h10M7 12h10M7 16h6M4 4h16v16H4Z',
  agent: 'M8 4h8v4h4v12H4V8h4ZM9 12h.01M15 12h.01M9 16h6',
  plugins: 'M8 3v4M16 3v4M5 7h14v4a7 7 0 0 1-14 0V7ZM9 18v3M15 18v3',
  tools: 'M4 6h10M4 12h16M4 18h10M17 3v6M7 9v6M17 15v6',
  automation: 'M12 3a9 9 0 1 0 9 9M12 7v5l4 2M18 3v5h5',
  security: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM8 12l3 3 5-6',
  history: 'M4 10a8 8 0 1 1 1 8M4 4v6h6M12 7v5l4 2',
  general: 'M5 8h14M5 16h14M9 5v6M15 13v6',
}
/** Shared native settings navigation uses the same skin hook as the existing account rail. */
export function createSettingsIcon(document: Document, icon: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('icon')
  svg.dataset.agnesRegion = 'icon'
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[icon] ?? paths.plugins ?? '')
  svg.appendChild(path)
  return svg
}
