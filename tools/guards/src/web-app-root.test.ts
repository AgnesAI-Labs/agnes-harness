import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
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
      const path = relative(root, file)
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
