import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const rootDocs = new Set([
  'README.md',
  'README.en.md',
  'README.zh-CN.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'AGENTS.md',
  'CLAUDE.md',
])

// Only an explicit list of prose paths can skip runtime validation. New file types,
// examples, configuration, lockfiles and documentation tooling take the full path.
export function isDocsOnly(paths) {
  return paths.length > 0 && paths.every((path) => rootDocs.has(path) || /^docs\/.+\.md$/.test(path))
}

export function changedPaths(base, head, cwd = process.cwd()) {
  if (![base, head].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha))) {
    throw new Error('Expected full PR base and head commit SHAs')
  }
  // Include both sides of a rename: moving source into docs must still run tests.
  // NUL separation preserves spaces, Unicode and newline characters in filenames.
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`, '--'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
}

export function detectDocsOnly(eventName, event, cwd) {
  // Main-branch pushes (including docs) and manually requested runs validate everything.
  if (eventName !== 'pull_request') return false
  return isDocsOnly(changedPaths(event.pull_request?.base?.sha, event.pull_request?.head?.sha, cwd))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const docsOnly = detectDocsOnly(
    process.env.GITHUB_EVENT_NAME,
    JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
  )
  appendFileSync(process.env.GITHUB_OUTPUT, `docs-only=${docsOnly}\n`)
  console.log(docsOnly ? 'Documentation-only PR: lightweight checks' : 'Full cross-platform validation')
}
