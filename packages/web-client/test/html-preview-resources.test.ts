/** @vitest-environment happy-dom */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { ArtifactRef } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { prepareHtmlPreview } from '../src/html-preview-resources.js'

const htmlRef = { sha256: 'a'.repeat(64), size: 100, mime: 'text/html' }
const svgRef = { sha256: 'b'.repeat(64), size: 60, mime: 'application/octet-stream' }
const encoded = (text: string) => ({ bytes: new TextEncoder().encode(text).buffer, base64: btoa(text) })
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10"/></svg>'
const detail = (paths = ['demo/page.html', 'demo/animation.svg'], refs = [htmlRef, svgRef]) => ({
  call: {
    name: 'present',
    toolUseId: 'p',
    args: { files: paths.map((path) => ({ path, name: '中文展示名' })) },
  },
  result: { toolUseId: 'p', structured: { deliverables: refs.map((ref) => ({ name: '中文展示名', ref })) } },
})

it('uses durable source paths rather than display names and replaces an SVG object with an inert image', async () => {
  const read = vi.fn(async () => encoded(svg))
  const content = await prepareHtmlPreview(
    '<style>object{width:100%}</style><object data="animation.svg" type="image/svg+xml" aria-label="插画"></object>',
    htmlRef,
    async () => detail() as never,
    read,
  )
  const template = document.createElement('template')
  template.innerHTML = content
  expect(template.content.querySelector('object')).toBeNull()
  const image = template.content.querySelector('img')
  expect(image?.src).toBe(`data:image/svg+xml;base64,${btoa(svg)}`)
  expect(image?.alt).toBe('插画')
  expect(read).toHaveBeenCalledWith(svgRef)
})

it.each(['missing.svg', '../animation.svg', '/admin/credentials', '%2e%2e/animation.svg'])(
  'refuses an unregistered or outside-directory dependency: %s',
  async (url) => {
    const read = vi.fn()
    await expect(
      prepareHtmlPreview(`<img src="${url}">`, htmlRef, async () => detail() as never, read),
    ).rejects.toMatchObject({ code: 'HTML_PREVIEW_RESOURCE_UNAVAILABLE' })
    expect(read).not.toHaveBeenCalled()
  },
)

it('keeps self-contained content unchanged without reading tool details or opening network paths', async () => {
  const source =
    '<h1>Title</h1><svg></svg><style>body{background:url(data:image/png;base64,AQ==);filter:url(#mask)}</style><img style="filter:url(#mask)" src=" data:image/png;base64,AQ== "><script src="https://invalid.example/x.js"></script>'
  const read = vi.fn(),
    get = vi.fn()
  expect(await prepareHtmlPreview(source, htmlRef, get, read)).toBe(source)
  expect(read).not.toHaveBeenCalled()
  expect(get).not.toHaveBeenCalled()
})

it('inlines explicitly delivered CSS, its image URLs and classic scripts without fetching URLs', async () => {
  const cssRef = { sha256: 'c'.repeat(64), size: 50, mime: 'text/css' }
  const jsRef = { sha256: 'd'.repeat(64), size: 20, mime: 'text/javascript' }
  const read = async (ref: ArtifactRef) =>
    encoded(
      ref.sha256 === cssRef.sha256
        ? 'body{background:url(animation.svg)}'
        : ref.sha256 === jsRef.sha256
          ? 'document.title="ok"'
          : svg,
    )
  const content = await prepareHtmlPreview(
    '<link rel="stylesheet" href="style.css"><script src="app.js"></script>',
    htmlRef,
    async () =>
      detail(
        ['demo/page.html', 'demo/animation.svg', 'demo/style.css', 'demo/app.js'],
        [htmlRef, svgRef, cssRef, jsRef],
      ) as never,
    read,
  )
  expect(content).toContain(`url("data:image/svg+xml;base64,${btoa(svg)}")`)
  expect(content).toContain(`src="data:text/javascript;base64,${btoa('document.title="ok"')}"`)
  expect(content).not.toContain('<link')
})

it.each([
  'data:image/png;base64,AQ== 1x, animation.svg 2x',
  'animation.svg 2x, data:image/png;base64,AQ== 1x',
  'animation.svg, animation.svg 2x',
])('rewrites only authorized relative srcset candidates: %s', async (srcset) => {
  const read = vi.fn(async () => encoded(svg))
  const content = await prepareHtmlPreview(
    `<img srcset="${srcset}">`,
    htmlRef,
    async () => detail() as never,
    read,
  )
  const image = new DOMParser().parseFromString(content, 'text/html').querySelector('img')
  expect(image?.getAttribute('srcset')).toContain(`data:image/svg+xml;base64,${btoa(svg)} 2x`)
  expect(image?.getAttribute('srcset')).not.toContain('animation.svg')
  if (srcset.includes('AQ=='))
    expect(image?.getAttribute('srcset')).toContain('data:image/png;base64,AQ== 1x')
  expect(read).toHaveBeenCalledExactlyOnceWith(svgRef)
})

it('retains full-document attributes and external deferred script semantics', async () => {
  const jsRef = { sha256: 'c'.repeat(64), size: 50, mime: 'text/javascript' }
  const script = 'window.ready = !!document.getElementById("target")'
  const content = await prepareHtmlPreview(
    '<!doctype html><html lang="zh-CN" style="color:red"><head><script defer src="app.js"></script></head><body class="page" style="padding:12px"><h1 id="target">Ready</h1></body></html>',
    htmlRef,
    async () => detail(['demo/page.html', 'demo/app.js'], [htmlRef, jsRef]) as never,
    async () => encoded(script),
  )
  const parsed = new DOMParser().parseFromString(content, 'text/html')
  expect(parsed.doctype?.name).toBe('html')
  expect(parsed.documentElement.lang).toBe('zh-CN')
  expect(parsed.documentElement.getAttribute('style')).toBe('color:red')
  expect(parsed.body.className).toBe('page')
  expect(parsed.body.getAttribute('style')).toBe('padding:12px')
  const element = parsed.head.querySelector('script')
  expect(element?.hasAttribute('defer')).toBe(true)
  expect(element?.getAttribute('src')).toBe(`data:text/javascript;base64,${btoa(script)}`)
  expect(element?.textContent).toBe('')
})

it('rejects unrelated tool identities, duplicate paths, reclaimed dependencies and excessive snapshot totals', async () => {
  for (const record of [
    { ...detail(), call: { ...detail().call, name: 'shell' } },
    { ...detail(), result: { ...detail().result, toolUseId: 'other' } },
    detail(['demo/page.html', 'demo/page.html']),
    detail(['demo/page.html', 'demo/copy.html', 'demo/animation.svg'], [htmlRef, htmlRef, svgRef]),
    detail(undefined, [{ ...htmlRef, sha256: 'c'.repeat(64) }, svgRef]),
    detail(undefined, [htmlRef, { ...svgRef, size: 1024 * 1024 }]),
  ]) {
    await expect(
      prepareHtmlPreview(
        '<object data="animation.svg"></object>',
        htmlRef,
        async () => record as never,
        async () => encoded(svg),
      ),
    ).rejects.toMatchObject({ code: 'HTML_PREVIEW_RESOURCE_UNAVAILABLE' })
  }
  await expect(
    prepareHtmlPreview(
      '<img src="animation.svg">',
      htmlRef,
      async () => detail() as never,
      async () => {
        throw Error('artifact_reclaimed')
      },
    ),
  ).rejects.toMatchObject({ code: 'HTML_PREVIEW_RESOURCE_UNAVAILABLE' })
})

it('loads authoring and pure preview exports in plain Node without a DOM or CSS loader', () => {
  const result = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "const client = await import('@agnes/web-client'); const html = await import('@agnes/web-ui/html-preview-resources'); const pdf = await import('@agnes/web-ui/pdf-preview-document'); process.stdout.write([typeof client.ClientResourceService, typeof html.prepareHtmlPreview, typeof pdf.initializePdfPreviewDocument, typeof document].join(','))",
    ],
    { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 10_000 },
  )
  expect(result).toBe('function,function,function,undefined')
})
