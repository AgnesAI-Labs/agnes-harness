import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { createScanner } from 'typescript/unstable/ast/scanner'
import { describe, expect, it } from 'vitest'
import { repoRoot } from './repo.js'

const root = repoRoot()

/**
 * The three workbench pages share one import map. Both UI builds externalize that same set and bind
 * `require('react')` back to it. Page CSS is the merged `/style.css`, `/antd.css`, and `/tokens.css`
 * those pages link; the assistant-ui companion file is folded into `/style.css` and removed.
 * Color bridges in tokens.css point `--ant-color-*` at `--agnes-*`. Scale bridges point at the
 * existing font, radius, and control variables. `style-src` stays `'self'` plus a per-document nonce.
 */

const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@agnes/cordis',
  '@agnes/web-client',
  '@agnes/web-ui/assistant-ui',
  'antd',
]

// The build scripts pass conversation/messages.css and conversation/markdown.css as join() segments,
// then append those files plus the markdown themes into style.css and remove assistant-ui.css.
const CSS_MARKERS = [
  'antd/dist/antd.css',
  'tokens.css',
  'style.css',
  'messages.css',
  'markdown.css',
  '@ant-design/x-markdown/themes/light.css',
  '@ant-design/x-markdown/themes/dark.css',
  'assistant-ui.css',
  'appendFile(',
  'rm(',
]

const PAGE_MARKERS = [
  'name="agnes-csp-nonce"',
  '__AGNES_CSP_NONCE__',
  'src="/theme.js"',
  'href="/style.css"',
  'href="/antd.css"',
  'href="/tokens.css"',
]

const SHARED_REACT_EXTERNAL =
  "['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']"
const SHARED_REACT_REQUIRE = "id === 'react'"
const PAGES = [
  'packages/web/public/index.html',
  'packages/web/public/admin.html',
  'packages/web/public/resources.html',
]
const BUILD_SCRIPTS = ['packages/web/tools/build.ts', 'packages/cli/tools/build-local.ts']
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage'])

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((item) => rightSet.has(item))
}

function assignedStrings(source: string, marker: string): string[] | undefined {
  const at = source.indexOf(marker)
  if (at < 0) return undefined
  const start = at + marker.length
  const end = source.indexOf(']', start)
  if (end < 0) return undefined
  return [...source.slice(start, end).matchAll(/['"]([^'"]+)['"]/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  )
}

function importMap(html: string): Record<string, string> {
  const match = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/)
  if (match?.[1] === undefined) throw new Error('page is missing its import map')
  const parsed = JSON.parse(match[1]) as { imports?: Record<string, string> }
  return parsed.imports ?? {}
}

function cssCompositionGaps(source: string): string[] {
  return CSS_MARKERS.filter((marker) => !source.includes(marker)).map((marker) => `missing ${marker}`)
}

function singletonGaps(source: string): string[] {
  const gaps: string[] = []
  if (!source.includes(SHARED_REACT_EXTERNAL))
    gaps.push('UI vendor build does not externalize the shared React modules')
  if (
    !source.includes("import * as __agnesSharedReact from 'react'") ||
    !source.includes(SHARED_REACT_REQUIRE)
  ) {
    gaps.push("UI vendor build does not bind require('react') to the shared React instance")
  }
  return gaps
}

function cspGaps(source: string): string[] {
  const gaps: string[] = []
  if (!source.includes("style-src 'self'")) gaps.push("base policy is missing style-src 'self'")
  if (!source.includes("style-src 'self' 'nonce-")) gaps.push('HTML responses do not attach a style nonce')
  if (source.includes('unsafe-inline')) gaps.push('policy contains unsafe-inline')
  return gaps
}

function tokenBridgeGaps(css: string): string[] {
  const gaps: string[] = []
  let colorBridges = 0
  for (const line of css.split('\n')) {
    const match = /^\s*(--ant-[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line)
    const name = match?.[1]
    const value = match?.[2]?.trim()
    if (name === undefined || value === undefined) continue
    if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(value)) gaps.push(`${name} uses a raw color`)
    const refs = [...value.matchAll(/var\((--[a-z0-9-]+)\)/g)].flatMap((item) =>
      item[1] === undefined ? [] : [item[1]],
    )
    if (refs.length === 0) gaps.push(`${name} does not reference a token`)
    for (const ref of refs) {
      const scale = ref.startsWith('--font-') || ref.startsWith('--radius-') || ref.startsWith('--control-')
      if (name.startsWith('--ant-color-')) {
        colorBridges++
        if (!ref.startsWith('--agnes-')) gaps.push(`${name} references ${ref}`)
        continue
      }
      if (!ref.startsWith('--agnes-') && !scale) gaps.push(`${name} references ${ref}`)
    }
  }
  if (colorBridges === 0) gaps.push('no --ant-color-* bridge to --agnes-*')
  return gaps
}

function at(tokens: readonly string[], index: number): string {
  return tokens[index] ?? ''
}

function quoted(token: string): string | undefined {
  if (
    (token.startsWith("'") && token.endsWith("'") && token.length >= 2) ||
    (token.startsWith('"') && token.endsWith('"') && token.length >= 2)
  ) {
    return token.slice(1, -1)
  }
  return undefined
}

function specifiersIn(source: string): string[] {
  const scanner = createScanner(true, 0, source)
  const tokens: string[] = []
  for (;;) {
    scanner.scan()
    const text = scanner.getTokenText()
    if (text === '') break
    tokens.push(text)
  }
  const specs: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = at(tokens, index)
    const next = at(tokens, index + 1)
    if (
      (token === 'import' || token === 'export' || (token === 'require' && at(tokens, index - 1) !== '.')) &&
      next === '('
    ) {
      const specifier = quoted(at(tokens, index + 2))
      if (specifier !== undefined) specs.push(specifier)
      continue
    }
    if (token !== 'from' && token !== 'import') continue
    const specifier = quoted(next)
    if (specifier !== undefined) specs.push(specifier)
  }
  return specs
}

function isExternalUi(specifier: string): boolean {
  return (
    specifier === 'antd' ||
    specifier.startsWith('antd/') ||
    specifier.startsWith('@ant-design/') ||
    specifier.startsWith('@assistant-ui/')
  )
}

function isForbiddenComponentImport(specifier: string): boolean {
  const names = ['@agnes/sdk', '@agnes/web-client', '@agnes/extension-api', '@agnes/cordis', 'cordis']
  return (
    names.some((name) => specifier === name || specifier.startsWith(`${name}/`)) ||
    specifier.startsWith('@cordisjs/')
  )
}

function posix(path: string): string {
  return path.split(sep).join('/')
}

function walkPackages(base: string, visit: (dir: string, json: Record<string, unknown>) => void): void {
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name) || !entry.isDirectory()) continue
      const full = join(dir, entry.name)
      const manifest = join(full, 'package.json')
      if (existsSync(manifest))
        visit(full, JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>)
      walk(full)
    }
  }
  walk(join(base, 'packages'))
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
    }
  }
  walk(dir)
  return out
}

function externalUiViolations(base: string): string[] {
  const violations: string[] = []
  walkPackages(base, (dir, json) => {
    if (json.name === '@agnes/web-ui') return
    const rel = posix(relative(base, dir))
    for (const field of DEP_FIELDS) {
      const deps = json[field]
      if (typeof deps !== 'object' || deps === null) continue
      for (const name of Object.keys(deps as Record<string, unknown>)) {
        if (isExternalUi(name)) violations.push(`${rel} ${field}: ${name}`)
      }
    }
    for (const file of sourceFiles(join(dir, 'src'))) {
      for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
        if (!isExternalUi(specifier)) continue
        violations.push(`${posix(relative(base, file))}: imports ${specifier}`)
      }
    }
  })
  return violations
}

function componentLayerGaps(packageDir: string): string[] {
  const gaps: string[] = []
  const json = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
  for (const field of DEP_FIELDS) {
    const deps = json[field]
    if (typeof deps !== 'object' || deps === null) continue
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      if (isForbiddenComponentImport(name)) gaps.push(`${field}: ${name}`)
    }
  }
  for (const file of sourceFiles(join(packageDir, 'src'))) {
    for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
      if (!isForbiddenComponentImport(specifier)) continue
      gaps.push(`${posix(relative(packageDir, file))}: imports ${specifier}`)
    }
  }
  return gaps
}

// The web-ui import fence scans this directory, so fixture specifiers are assembled at runtime.
function valueImport(binding: string, specifier: string): string {
  return `import { ${binding} } from '${specifier}'\n`
}

function withTemp(files: Record<string, string>, run: (base: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'agnes-ui-vendor-'))
  try {
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(base, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text)
    }
    run(base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

describe('shared UI platform externals', () => {
  it('uses one external set in both UI builds and all three page import maps', () => {
    const lists = BUILD_SCRIPTS.map((rel) => assignedStrings(read(rel), 'platformExternals = ['))
    for (const [index, list] of lists.entries()) {
      expect(list, BUILD_SCRIPTS[index]).toBeDefined()
      expect(sameMembers(list ?? [], PLATFORM_EXTERNALS), BUILD_SCRIPTS[index]).toBe(true)
    }
    const maps = PAGES.map((rel) => importMap(read(rel)))
    for (const [index, map] of maps.entries()) {
      expect(sameMembers(Object.keys(map), PLATFORM_EXTERNALS), PAGES[index]).toBe(true)
    }
    expect(maps[1]).toEqual(maps[0])
    expect(maps[2]).toEqual(maps[0])
    const vendorNames = Object.values(maps[0] ?? {}).map((url) => {
      const match = /^\/vendor\/(.+)\.js$/.exec(url)
      if (match?.[1] === undefined) throw new Error(`import map target is not a vendor file: ${url}`)
      return match[1]
    })
    const served = assignedStrings(
      read('packages/web-server/src/vendor-assets.ts'),
      'VENDOR_ENTRY_NAMES = new Set([',
    )
    expect(served, 'vendor entry names').toBeDefined()
    expect(sameMembers(vendorNames, served ?? [])).toBe(true)
  })

  it("externalizes React in both UI vendor builds and binds require('react') to that instance", () => {
    for (const rel of BUILD_SCRIPTS) {
      const gaps = singletonGaps(read(rel))
      expect(gaps, rel).toEqual([])
    }
  })

  it('rejects a vendor build that drops the shared React require binding', () => {
    const source = `external: ${SHARED_REACT_EXTERNAL}\n`
    expect(singletonGaps(source)).not.toEqual([])
    expect(singletonGaps(`${source}import * as __agnesSharedReact from 'react'\n`)).not.toEqual([])
  })
})

describe('styles the three pages actually load', () => {
  it('copies antd and tokens, folds conversation and markdown CSS into style.css, then removes the companion', () => {
    for (const rel of BUILD_SCRIPTS) {
      const gaps = cssCompositionGaps(read(rel))
      expect(gaps, rel).toEqual([])
    }
    for (const rel of PAGES) {
      const html = read(rel)
      const missing = PAGE_MARKERS.filter((marker) => !html.includes(marker))
      expect(missing, rel).toEqual([])
    }
  })

  it('rejects a build script that does not compose those styles', () => {
    expect(cssCompositionGaps('copyFile(antdCss, antd.css)\n')).not.toEqual([])
  })

  it('bridges ant color tokens to agnes tokens', () => {
    const gaps = tokenBridgeGaps(read('packages/web-ui/src/tokens.css'))
    expect(gaps, gaps.join('\n')).toEqual([])
  })

  it('rejects a raw color and a color token that does not reference --agnes-*', () => {
    const raw = tokenBridgeGaps('--ant-color-primary: #ffffff;\n')
    const drifted = tokenBridgeGaps('--ant-color-primary: var(--font-size-body);\n')
    expect(raw.join('\n')).toContain('raw color')
    expect(drifted.join('\n')).toContain('--font-size-body')
  })
})

describe('document style policy', () => {
  it('keeps style-src self and adds a nonce on each HTML response', () => {
    const gaps = cspGaps(read('packages/web-server/src/server.ts'))
    expect(gaps, gaps.join('\n')).toEqual([])
  })

  it('rejects a policy that adds unsafe-inline', () => {
    const source = "const contentSecurityPolicy = `style-src 'self' 'unsafe-inline'`\n"
    expect(cspGaps(source).join('\n')).toContain('unsafe-inline')
  })
})

describe('UI libraries stay in the component layer', () => {
  it('pins antd and assistant-ui on web-ui and keeps them out of other packages', () => {
    const webUi = JSON.parse(read('packages/web-ui/package.json')) as {
      dependencies?: Record<string, string>
    }
    expect(webUi.dependencies?.antd).toBe('6.6.5')
    expect(webUi.dependencies?.['@assistant-ui/react']).toBe('0.11.27')
    const violations = externalUiViolations(root)
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('rejects antd outside web-ui', () => {
    withTemp(
      {
        'packages/stray/package.json': JSON.stringify({
          name: '@agnes/stray',
          dependencies: { antd: '1.0.0' },
        }),
        'packages/stray/src/panel.tsx': valueImport('Thread', '@assistant-ui/react'),
        'packages/web/tools/vendor/antd-entry.js': valueImport('Button', 'antd'),
      },
      (base) => {
        const violations = externalUiViolations(base)
        const text = violations.join('\n')
        expect(text).toContain('dependencies: antd')
        expect(text).toContain('@assistant-ui/react')
        expect(text).not.toContain('tools/vendor')
      },
    )
  })

  it('does not import the SDK, web-client, extension-api, or Cordis from web-ui', () => {
    const gaps = componentLayerGaps(join(root, 'packages/web-ui'))
    expect(gaps, gaps.join('\n')).toEqual([])
  })

  it('rejects a web-ui import of web-client', () => {
    withTemp(
      {
        'package.json': JSON.stringify({
          name: '@agnes/web-ui',
          dependencies: { '@agnes/web-client': 'workspace:*' },
        }),
        'src/panel.tsx': valueImport('app', '@agnes/web-client'),
      },
      (base) => {
        const gaps = componentLayerGaps(base)
        expect(gaps.join('\n')).toContain('@agnes/web-client')
      },
    )
  })
})

describe('plugin external list', () => {
  it('matches the page import map, including antd and assistant-ui', () => {
    const list = assignedStrings(read('packages/web-client/src/externals.ts'), 'externals = [')
    expect(list, 'externals').toBeDefined()
    expect(sameMembers(list ?? [], PLATFORM_EXTERNALS)).toBe(true)
  })

  it('rejects a plugin external list that drops assistant-ui', () => {
    const short = PLATFORM_EXTERNALS.filter((name) => name !== '@agnes/web-ui/assistant-ui')
    expect(sameMembers(short, PLATFORM_EXTERNALS)).toBe(false)
  })

  // A full browser pass would load all three pages and check one React, one assistant-ui, and no
  // CSP or asset failure. This file only reads the build scripts and the pages.
  it.todo('the three pages load one React and one assistant-ui without a CSP violation or a missing asset')
})
