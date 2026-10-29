import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, it } from 'vitest'
import { isTestFile, listPackages, listSourceFiles, repoRoot } from './repo.js'

it('keeps every Web region under the one application root and ConfigProvider', () => {
  const root = repoRoot()
  const calls: string[] = []
  const imports: string[] = []
  const providers: string[] = []
  for (const pkg of listPackages(root).filter((pkg) => /web/.test(pkg.name))) {
    for (const file of listSourceFiles(join(pkg.dir, 'src')).filter((file) => !isTestFile(file))) {
      const code = readFileSync(file, 'utf8')
      const path = relative(root, file).split(sep).join('/')
      for (const _match of code.matchAll(/\b(?:createRoot|createAntdRoot)\s*\(/g)) calls.push(path)
      if (/from\s*['"]react-dom\/client['"]/.test(code)) imports.push(path)
      for (const _match of code.matchAll(/<ConfigProvider\b/g)) providers.push(path)
    }
  }
  expect(calls).toEqual(['packages/web-ui/src/antd-root.tsx'])
  expect(imports).toEqual(['packages/web-ui/src/antd-root.tsx'])
  expect(providers).toEqual(['packages/web-ui/src/antd-root.tsx'])
})

function isBootstrapHtml(html: string): boolean {
  const code = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>')
  const body = code.match(/<body\b[^>]*>([\s\S]*?)<\/body>/)?.[1]
  if (!body || !/^\s*<div\s+id="app-root"\s*>\s*<\/div>\s*$/.test(body)) return false
  if (/\bdata-i18n/.test(code)) return false
  return [...code.matchAll(/<([a-z][\w-]*)\b/g)].every((match) =>
    ['html', 'head', 'meta', 'link', 'title', 'script', 'body', 'div'].includes(match[1] ?? ''),
  )
}

it('keeps index.html bootstrap-only, rejecting business elements and static translations', () => {
  const html = readFileSync(join(repoRoot(), 'packages/web/public/index.html'), 'utf8')
  expect(isBootstrapHtml(html)).toBe(true)
  for (const change of [
    html.replace('<div id="app-root"></div>', '<main id="main-content"></main>'),
    html.replace('<div id="app-root"></div>', '<div id="app-root"><section>business</section></div>'),
    html.replace('<div id="app-root"></div>', '<div id="app-root" data-i18n="business"></div>'),
    html.replace('<div id="app-root"></div>', '<div id="app-root"></div><div id="session"></div>'),
    html.replace('</head>', '<button>business</button></head>'),
  ])
    expect(isBootstrapHtml(change)).toBe(false)
})

it('keeps the controller composition free of element access and listeners', () => {
  // app.ts composes controllers. AppShell hands over the hosts it rendered, each region answers for
  // its own state, and window or document listeners are bound in app/global-events.ts.
  const touch =
    /\bdocument\.|\bquerySelector|\bclassList\b|\.hidden\s*=|\bsetAttribute\b|\baddEventListener\b/
  const code = readFileSync(join(repoRoot(), 'packages/web/src/app.ts'), 'utf8')
  expect(code.split('\n').filter((line) => touch.test(line))).toEqual([])
  expect(touch.test("document.getElementById('approval')")).toBe(true)
  expect(touch.test("window.addEventListener('focus', refresh)")).toBe(true)
})

it('keeps the admin addresses as aliases of the workbench with no shell of their own', () => {
  for (const page of ['admin.html', 'resources.html']) {
    const html = readFileSync(join(repoRoot(), 'packages/web/public', page), 'utf8')
    expect(html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/)?.[1]?.trim(), page).toBe('')
    expect(html, page).not.toMatch(/\bdata-i18n/)
  }
})

it('keeps collapsible sections on the one Disclosure primitive', () => {
  const root = repoRoot()
  const native = /<details\b|\bcreateElement\s*\(\s*['"]details['"]/
  const offenders: string[] = []
  for (const pkg of listPackages(root).filter((pkg) => /web/.test(pkg.name))) {
    for (const file of listSourceFiles(join(pkg.dir, 'src')).filter((file) => !isTestFile(file))) {
      if (native.test(readFileSync(file, 'utf8'))) offenders.push(relative(root, file).split(sep).join('/'))
    }
  }
  expect(
    offenders,
    'Use Disclosure from @agnes/web-ui; no Web package renders a native <details> element.',
  ).toEqual([])
  expect(native.test('<details className="x">')).toBe(true)
  expect(native.test('createElement("details", null)')).toBe(true)
  expect(native.test('<Disclosure summary="x">')).toBe(false)
})
