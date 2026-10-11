import { type IconName, icons } from './ui/icons.js'

const navigation: Readonly<Record<string, IconName>> = {
  accounts: 'list',
  agent: 'bot',
  plugins: 'plug',
  tools: 'sliders-horizontal',
  diagnostics: 'activity',
  automation: 'clock',
  security: 'shield-check',
  history: 'history',
  general: 'settings',
}
/** Native controls read the exact geometry used by the React Icon. Existing skin hook is retained. */
export function createSettingsIcon(document: Document, icon: string): SVGSVGElement {
  const name = navigation[icon] ?? (Object.hasOwn(icons, icon) ? (icon as IconName) : 'plug')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('icon', 'agh-icon')
  svg.dataset.agnesRegion = 'icon'
  svg.dataset.size = '20'
  for (const [attribute, value] of Object.entries({
    viewBox: '0 0 24 24',
    width: '20',
    height: '20',
    'aria-hidden': 'true',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.75',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }))
    svg.setAttribute(attribute, value)
  for (const [tag, attributes] of icons[name]) {
    const node = document.createElementNS(svg.namespaceURI, tag)
    for (const [attribute, value] of Object.entries(attributes)) node.setAttribute(attribute, value)
    svg.appendChild(node)
  }
  return svg
}
