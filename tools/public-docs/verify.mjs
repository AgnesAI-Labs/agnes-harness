#!/usr/bin/env node
// Read-only documentation, link and source-anchor checks for the current source tree.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const docs = resolve(root, 'docs')
const files = []
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
  }
}
walk(docs)
const errors = []
const fail = (file, message) => errors.push(`${relative(root, file)}: ${message}`)
const entrypoints = new Set(
  ['README.md', 'README.en.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md'].map((name) =>
    resolve(root, name),
  ),
)
for (const file of entrypoints) {
  if (existsSync(file)) files.push(file)
  else fail(file, 'missing root documentation entrypoint')
}
const securityFile = resolve(root, 'SECURITY.md')
if (existsSync(securityFile)) {
  files.push(securityFile)
  entrypoints.add(securityFile)
}
const content = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]))
const noCode = (text) => text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')
function anchors(text) {
  const seen = new Map()
  const result = new Set()
  for (const match of noCode(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = match[1]
      .replace(/<[^>]+>/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
      .replace(/ /g, '-')
    const count = seen.get(slug) ?? 0
    result.add(count ? `${slug}-${count}` : slug)
    seen.set(slug, count + 1)
  }
  for (const match of text.matchAll(/\bid=["']([^"']+)["']/g)) result.add(match[1])
  return result
}
const within = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`)
let checkedLinks = 0
let externalLinks = 0
for (const [file, text] of content) {
  if (Array.from(text).some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))))
    fail(file, 'control character')
  if (/(?:\/Users\/|[A-Z]:\\Users\\|\/home\/[a-z][a-z0-9_-]*\/)/i.test(text))
    fail(file, 'personal absolute path')
  if (/\bTODO\b|\bTBD\b/.test(text)) fail(file, 'unfinished placeholder')
  if (/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/.test(text))
    fail(file, 'credential-like value')
  for (const match of noCode(text).matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const link = match[1].replace(/^<|>$/g, '').split(/\s+"/)[0]
    if (/^(?:https?:|mailto:)/.test(link)) {
      externalLinks++
      continue
    }
    const [path, fragment] = link.split('#')
    const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file
    checkedLinks++
    if (!within(root, target)) {
      fail(file, `link escapes repository: ${link}`)
      continue
    }
    if (!existsSync(target)) {
      fail(file, `missing target: ${link}`)
      continue
    }
    if (fragment && statSync(target).isFile() && target.endsWith('.md')) {
      if (!anchors(readFileSync(target, 'utf8')).has(decodeURIComponent(fragment)))
        fail(file, `missing anchor: ${link}`)
    }
  }
}
const manifestFile = resolve(root, 'tools/public-docs/source-checks.json')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const sourceBaselines = new Map()
for (const check of manifest) {
  const file = resolve(root, check.path)
  if (!within(root, file)) {
    fail(manifestFile, `source path escapes repository: ${check.path}`)
    continue
  }
  const baseline = check.revision ?? 'worktree'
  sourceBaselines.set(baseline, (sourceBaselines.get(baseline) ?? 0) + 1)
  let text
  if (check.revision !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(check.revision)) {
      fail(manifestFile, `pinned source requires a full commit SHA: ${check.path}`)
      continue
    }
    try {
      text = execFileSync('git', ['show', `${check.revision}:${check.path}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      fail(manifestFile, `pinned source unavailable: ${check.revision}:${check.path}; no worktree fallback`)
      continue
    }
  } else {
    if (!existsSync(file)) {
      fail(manifestFile, `missing source ${check.path}`)
      continue
    }
    text = readFileSync(file, 'utf8')
  }
  for (const token of check.includes ?? [])
    if (!text.includes(token)) fail(file, `[${baseline}] source changed; review documented token: ${token}`)
  for (const token of check.excludes ?? [])
    if (text.includes(token))
      fail(file, `[${baseline}] source wiring changed; review documented absence: ${token}`)
}
for (const [baseline, count] of sourceBaselines) console.log(`Source checks: ${baseline}: ${count}`)
for (const error of errors) console.error(error)
console.log(
  `${files.length} Markdown files; ${checkedLinks} local links; ${externalLinks} external links (not fetched); ${manifest.length} source checks; ${errors.length} errors`,
)
process.exitCode = errors.length ? 1 : 0
