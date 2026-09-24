/** @vitest-environment happy-dom */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mountRenderedIndex, readStaticPage, resetWebDom } from './web-dom-fixture.js'

type RegionHook = { region: string; tag: string }
type PageRoot = { page: string; root: ParentNode }

/**
 * The region hooks are the one selector vocabulary a skin may depend on, so they are a contract
 * rather than incidental markup: a skin written against `[data-agnes-region="composer"]` must keep
 * working when the feature packages rename their own classes. This table is the contract, and the
 * case below fails in both directions — an added, removed, duplicated or misplaced hook is red.
 *
 * `dialog` and `settings-pane` legitimately repeat within the workbench: a skin styles every dialog
 * and every settings pane, so the expected value is a count, not "exactly one".
 */
const EXPECTED: Record<string, Record<string, readonly [string, number]>> = {
  'index.html': {
    app: ['body', 1],
    sidebar: ['aside', 1],
    topbar: ['header', 1],
    conversation: ['div', 1],
    trace: ['aside', 1],
    rightbar: ['aside', 1],
    transcript: ['section', 1],
    'empty-state': ['section', 1],
    approval: ['section', 1],
    composer: ['form', 1],
    'composer-input': ['textarea', 1],
    // Every icon glyph, so a skin can restyle or replace them without reaching for `.icon`.
    icon: ['svg', 26],
    // 插件详情、资源详情和账户详情/新增都使用独立模态框。
    dialog: ['dialog', 9],
    'settings-pane': ['section', 6],
  },
  // These two pages intentionally use the static sampling path; they do not start the workbench.
  'admin.html': { app: ['body', 1], topbar: ['header', 1], dialog: ['dialog', 4] },
  'resources.html': { app: ['body', 1], topbar: ['header', 1], dialog: ['dialog', 3] },
}

function hooks(root: ParentNode): RegionHook[] {
  return [...root.querySelectorAll<HTMLElement>('[data-agnes-region]')].map((node) => ({
    tag: node.tagName.toLowerCase(),
    region: node.dataset.agnesRegion ?? '',
  }))
}

function assertRegionContract(page: string, root: ParentNode): void {
  const found = hooks(root)
  const counts = new Map<string, { tag: string; count: number }>()
  for (const { region, tag } of found) {
    const seen = counts.get(region)
    if (seen === undefined) counts.set(region, { tag, count: 1 })
    else {
      // One region must never span two tag names: a skin selector would then hit different elements.
      expect(seen.tag, `${page} region ${region} spans <${seen.tag}> and <${tag}>`).toBe(tag)
      seen.count += 1
    }
  }
  expect(
    Object.fromEntries([...counts].map(([region, value]) => [region, `${value.tag}x${value.count}`])),
  ).toEqual(
    Object.fromEntries(
      Object.entries(EXPECTED[page] as Record<string, readonly [string, number]>).map(
        ([region, [tag, count]]) => [region, `${tag}x${count}`],
      ),
    ),
  )
}

function skinSamples(): PageRoot[] {
  return [
    { page: 'index.html', root: document },
    { page: 'admin.html', root: readStaticPage('admin.html') },
    { page: 'resources.html', root: readStaticPage('resources.html') },
  ]
}

describe('skin region hooks', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  beforeEach(async () => {
    runtime = await mountRenderedIndex()
  })

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
  })

  it.each(Object.keys(EXPECTED))('%s declares exactly the contracted regions', (page) => {
    const root = page === 'index.html' ? document : readStaticPage(page as 'admin.html' | 'resources.html')
    assertRegionContract(page, root)
  })

  it('keeps the shared shell hooks on every page', () => {
    for (const { page, root } of skinSamples()) {
      const regions = new Set(hooks(root).map((hook) => hook.region))
      // A skin that paints the app background or the header band must work on all three pages,
      // including the standalone management pages reached from the workbench.
      for (const shared of ['app', 'topbar', 'dialog'])
        expect(regions.has(shared), `${page} is missing ${shared}`).toBe(true)
    }
  })

  it('matches the region table in the skin authoring guide', () => {
    // The guide's table is the contract a skin author reads; it must list exactly the regions this
    // file pins. Several workbench regions are component-rendered, so the table is compared against
    // the EXPECTED contract rather than the static markup.
    const packageRoot = process.cwd().endsWith('/packages/web')
      ? process.cwd()
      : resolve(process.cwd(), 'packages/web')
    const doc = readFileSync(resolve(packageRoot, '../../docs/develop/skins.md'), 'utf8')
    const listed = new Set([...doc.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1] as string))
    const contracted = new Set<string>()
    for (const page of Object.keys(EXPECTED))
      for (const region of Object.keys(EXPECTED[page] as Record<string, readonly [string, number]>))
        contracted.add(region)
    expect([...listed].sort()).toEqual([...contracted].sort())
    expect(listed.size).toBeGreaterThan(5)
  })

  it('finds hooks at all instead of passing on an empty parse', () => {
    for (const { root } of skinSamples()) expect(hooks(root).length).toBeGreaterThan(2)
  })

  it('reports built-in slots from live registrations rather than their declared manifest', () => {
    // The sidebar owner now carries both the legacy `ui:sidebar` boundary and the DSH `sidebar`
    // frame that is rendered inside it.
    expect(runtime?.actualSlots('@agnes/web-sidebar')).toEqual(['sidebar', 'ui:sidebar'])
    // The conversation owner carries the DSH shell seam and session header alongside the legacy
    // `ui:conversation` boundary.
    expect(runtime?.actualSlots('@agnes/web-conversation')).toEqual([
      'main.conversation',
      'ui:conversation',
      'conversation.session',
      'conversation.session.header',
    ])
    // Settings panes now have separate live rows; this is runtime evidence rather than the
    // declaration copied out of the built-in manifest.
    expect(runtime?.actualSlots('@agnes/web-settings-plugins')).toEqual(['ui:settings-pane.plugin'])
  })

  it('fails when a rendered region hook is removed', () => {
    document.querySelector('[data-agnes-region="approval"]')?.removeAttribute('data-agnes-region')
    expect(() => assertRegionContract('index.html', document)).toThrow()
  })

  it('fails when a rendered region hook changes tag', () => {
    const original = document.querySelector('textarea[data-agnes-region="composer-input"]')
    expect(original).not.toBeNull()
    const replacement = document.createElement('div')
    replacement.dataset.agnesRegion = 'composer-input'
    original?.replaceWith(replacement)
    expect(() => assertRegionContract('index.html', document)).toThrow()
  })

  it('fails when a single rendered region is duplicated', () => {
    const sidebar = document.querySelector('[data-agnes-region="sidebar"]')
    expect(sidebar).not.toBeNull()
    sidebar?.parentElement?.append(sidebar.cloneNode(true))
    expect(() => assertRegionContract('index.html', document)).toThrow()
  })
})

/**
 * R1 (design §20). A skin wins the cascade only because its `adoptedStyleSheets` entry comes after
 * every document style sheet — and cascade order only decides ties. So a base rule that declares
 * a skinnable surface property on the element's `#id` (1,0,0) outranks the region selector (0,1,0)
 * and the skin silently loses, no matter how late it is registered.
 */
const SURFACE_PROPERTY =
  /^(?:background(?:-[a-z]+)?|border(?:-[a-z]+)*(?:-(?:color|width|style))?|box-shadow|color|backdrop-filter|outline(?:-[a-z]+)*|fill|stroke)$/

/**
 * `dialog` is a deliberate exception, not an oversight: nine workbench dialogs share the one
 * region hook, while the settings dialog (`#config`) carries its own surface, so moving it onto the
 * shared rule would repaint unrelated dialogs. Its surface stays reachable through the token layer.
 */
const SURFACE_EXCEPTIONS: Record<string, { region: string; why: string }> = {
  '#config': {
    region: 'dialog',
    why: 'settings dialog owns a distinct surface; documented in design §20.3',
  },
}

function hookedIds(samples: readonly PageRoot[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const { root } of samples)
    for (const node of root.querySelectorAll<HTMLElement>('[data-agnes-region][id]')) {
      if (node.id !== '') found.set(node.id, node.dataset.agnesRegion ?? '')
    }
  return found
}

/** Leaf rule blocks as `selector` → declared property names. Nested at-rules fall out naturally. */
function cssBlocks(css: string): Array<{ selector: string; properties: string[] }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks: Array<{ selector: string; properties: string[] }> = []
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    blocks.push({
      selector: (match[1] as string).trim(),
      properties: (match[2] as string)
        .split(';')
        .map((declaration) => declaration.split(':')[0]?.trim() ?? '')
        .filter((property) => property !== ''),
    })
  }
  return blocks
}

function assertNoIdSurfaceProperties(css: string, samples: readonly PageRoot[]): void {
  const hooked = hookedIds(samples)
  expect(hooked.size).toBeGreaterThan(10)
  const violations: string[] = []
  for (const { selector, properties } of cssBlocks(css)) {
    for (const rawPart of selector.split(',')) {
      const part = rawPart.trim()
      // Interaction states and pseudo-elements are intentionally left on id rules: a skin must not
      // be able to erase a focus ring.
      if (part.includes(':')) continue
      const id = /(?:^|[\s>+~])#([\w-]+)$/.exec(part)?.[1]
      if (id === undefined || !hooked.has(id)) continue
      if (SURFACE_EXCEPTIONS[`#${id}`] !== undefined) continue
      const offending = properties.filter((property) => SURFACE_PROPERTY.test(property))
      if (offending.length > 0) violations.push(`${part} { ${offending.join('; ')} }`)
    }
  }
  expect(violations).toEqual([])
}

describe('skin region surface invariant (R1)', () => {
  const css = readFileSync(resolve(process.cwd(), 'packages/web/public/style.css'), 'utf8')
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined
  let samples: PageRoot[]

  beforeAll(async () => {
    runtime = await mountRenderedIndex()
    samples = skinSamples()
  })

  afterAll(async () => {
    await runtime?.dispose()
    resetWebDom()
  })

  it('uses rendered index hooks and explicit static-page samples for the id-to-region map', () => {
    const index = samples.find(({ page }) => page === 'index.html')
    expect(index?.root).toBe(document)
    expect(hookedIds(samples).size).toBeGreaterThan(10)
  })

  it('never declares a skinnable surface property on a hooked element id', () => {
    assertNoIdSurfaceProperties(css, samples)
  })

  it('keeps the surface declarations reachable through the region selector instead', () => {
    const regionRule = (region: string): string[] =>
      cssBlocks(css)
        .filter(({ selector }) => selector === `[data-agnes-region="${region}"]`)
        .flatMap(({ properties }) => properties)
    for (const [region, property] of [
      ['app', 'background'],
      ['empty-state', 'color'],
      ['approval', 'background'],
      ['composer', 'background'],
      ['composer', 'border'],
      ['composer', 'backdrop-filter'],
      ['composer-input', 'background'],
      ['composer-input', 'border'],
    ] as const)
      expect(regionRule(region), `${region} is missing ${property}`).toContain(property)
  })

  it('keeps every documented exception real, so a stale allowlist is caught', () => {
    const hooked = hookedIds(samples)
    for (const [id, entry] of Object.entries(SURFACE_EXCEPTIONS)) {
      expect(hooked.get(id.slice(1)), `${id} is no longer a hooked element`).toBe(entry.region)
      const declares = cssBlocks(css)
        .filter(({ selector }) =>
          selector
            .split(',')
            .map((part) => part.trim())
            .some((part) => !part.includes(':') && part.endsWith(id)),
        )
        .flatMap(({ properties }) => properties)
        .some((property) => SURFACE_PROPERTY.test(property))
      expect(declares, `${id} no longer declares a surface property — drop the exception`).toBe(true)
      expect(entry.why).not.toBe('')
    }
  })

  it('fails when an id surface property is restored', () => {
    expect(() => assertNoIdSurfaceProperties(`${css}\n#composer { background: red; }`, samples)).toThrow()
  })
})
