import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, it } from 'vitest'
import { isTestFile, listPackages, listSourceFiles, repoRoot } from './repo.js'
import { webComponentViolations } from './web-component-boundary.js'

it('rejects DOM writes, intrinsic controls and copied component classes across Web packages', () => {
  for (const [source, rule] of [
    ['document.createElement("div")', 'dom'],
    ['host.ownerDocument.createElement("div")', 'dom'],
    ['owner.createElement("div")', 'dom'],
    ['doc.createElementNS("namespace", "svg")', 'dom'],
    ['node.innerHTML = html', 'dom'],
    ['<button />', 'intrinsic'],
    ['createElement("input", {})', 'intrinsic'],
    ['<div className="agnes-ui-button agh-btn--danger" />', 'className'],
    ['node.classList.add("primary-button")', 'className'],
    ['const classes = [\n"agh-table",\n"agnes-ui-button"\n]', 'className'],
    ['<div id="report" className="agh-meta" />', 'className'],
    ['<div className="agnes-ui-ready" />', 'className'],
    ['const type = "agh-btn"; node.className = type', 'className'],
    ['const id = "agnes-ui-button"; node.className = id', 'className'],
  ])
    expect(
      webComponentViolations(source ?? '', 'packages/web/src/new.tsx').some((v) => v.rule === rule),
    ).toBe(true)
  expect(
    webComponentViolations(
      '// document.createElement("div")\nReact.createElement(Component)',
      'packages/web/src/new.tsx',
    ),
  ).toEqual([])
  expect(webComponentViolations('node.querySelector(".agnes-ui-button")', 'packages/web/src/new.ts')).toEqual(
    [],
  )
  expect(
    webComponentViolations(
      '<p id="agh-meta" />; const message = { type: "agnes-ui-init" }; if (message.type === "agnes-ui-loaded" || message.type !== "agnes-ui-error") {}',
      'packages/web/src/new.tsx',
    ),
  ).toEqual([])
  expect(
    webComponentViolations('<button className="agh-btn" />', 'packages/web-ui/src/ui/button.tsx'),
  ).toEqual([])
  expect(
    webComponentViolations('<button class="primary-button"></button>', 'packages/web/public/index.html').map(
      (v) => v.rule,
    ),
  ).toEqual(['intrinsic', 'className'])
})

it('keeps only the exact existing offenders; remove entries as each migration lands', () => {
  const root = repoRoot()
  const allow = JSON.parse(readFileSync(join(root, 'tools/guards/web-component-allowlist.json'), 'utf8')) as {
    offenders: Record<string, Partial<Record<'dom' | 'intrinsic' | 'className', number>>>
  }
  const actual: typeof allow.offenders = {}
  for (const pkg of listPackages(root).filter((pkg) => /web/.test(pkg.name))) {
    for (const file of listSourceFiles([join(pkg.dir, 'src'), join(pkg.dir, 'public')], {
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.html'],
    }).filter((file) => !isTestFile(file))) {
      const path = relative(root, file).split(sep).join('/')
      for (const { rule } of webComponentViolations(readFileSync(file, 'utf8'), path)) {
        actual[path] ??= {}
        const row = actual[path]
        row[rule] = (row[rule] ?? 0) + 1
      }
    }
  }
  expect(actual, 'New/increased offences fail; stale allowances must be removed (never reseed).').toEqual(
    allow.offenders,
  )
})
