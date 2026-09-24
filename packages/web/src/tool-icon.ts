/** 工具行前缀图标：按工具名给一个字形。
 *
 *  路径数据取自客户端的依赖 `lucide-react@0.575`（`dist/esm/icons/*.js`），
 *  与页面其余 .icon 同为 24 网格描边字形，故直接复用 `.icon` 的 stroke 口径。
 *  客户端的 `components/icons/toolcalls/*` 是 11×11 的彩色圆角块（含渐变），
 *  与本页的单色描边体系不同族，故不采用那套。
 */

type Glyph = readonly (readonly [tag: 'path' | 'circle' | 'rect', attrs: string])[]

const SEARCH: Glyph = [
  ['path', 'd="m21 21-4.34-4.34"'],
  ['circle', 'cx="11" cy="11" r="8" x="11" y="11"'],
]
const TERMINAL: Glyph = [
  ['path', 'd="M12 19h8"'],
  ['path', 'd="m4 17 6-6-6-6"'],
]
const EYE: Glyph = [
  [
    'path',
    'd="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"',
  ],
  ['circle', 'cx="12" cy="12" r="3" x="12" y="12"'],
]
const FILE_PEN: Glyph = [
  [
    'path',
    'd="M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34"',
  ],
  ['path', 'd="M14 2v5a1 1 0 0 0 1 1h5"'],
  [
    'path',
    'd="M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z"',
  ],
]
const GLOBE: Glyph = [
  ['circle', 'cx="12" cy="12" r="10" x="12" y="12"'],
  ['path', 'd="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"'],
  ['path', 'd="M2 12h20"'],
]
const FOLDER: Glyph = [
  [
    'path',
    'd="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"',
  ],
]
const WRENCH: Glyph = [
  [
    'path',
    'd="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"',
  ],
]

/** 名字里出现这些片段就用对应字形；顺序即优先级（先匹配到者胜）。 */
const MATCHERS: readonly (readonly [pattern: RegExp, glyph: Glyph])[] = [
  [/(search|grep|find|query|lookup)/i, SEARCH],
  [/(shell|bash|exec|run|command|terminal)/i, TERMINAL],
  [/(read|cat|view|load|open_file|fetch_file)/i, EYE],
  [/(write|edit|create|update|patch|replace|apply)/i, FILE_PEN],
  [/(web|http|url|fetch|browse|scrape|download)/i, GLOBE],
  [/(ls|dir|list|glob|walk|tree)/i, FOLDER],
]

const FALLBACK = WRENCH

function glyphFor(name: string): Glyph {
  for (const [pattern, glyph] of MATCHERS) if (pattern.test(name)) return glyph
  return FALLBACK
}

/** 生成工具行的前缀图标元素（样式沿用 `.icon`，另加 `tool-icon` 供布局微调）。 */
export function toolIcon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'icon tool-icon')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const [tag, attrs] of glyphFor(name)) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [, attribute, value] of attrs.matchAll(/([a-z-]+)="([^"]*)"/g)) {
      if (attribute === undefined || value === undefined) continue
      node.setAttribute(attribute, value)
    }
    svg.append(node)
  }
  return svg
}
