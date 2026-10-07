import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Use an installed or cached Playwright package. Never download a browser as part of acceptance.
const require = createRequire(import.meta.url)
let packagePath = process.env.AGH_PLAYWRIGHT_PACKAGE
if (!packagePath) {
  try {
    packagePath = dirname(require.resolve('playwright/package.json'))
  } catch {
    const cache = join(process.env.npm_config_cache ?? join(homedir(), '.npm'), '_npx')
    const candidates = existsSync(cache)
      ? readdirSync(cache)
          .map((id) => join(cache, id, 'node_modules/playwright'))
          .filter((path) => existsSync(join(path, 'cli.js')))
      : []
    candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    packagePath = candidates[0]
  }
}
if (!packagePath)
  throw new Error(
    'Install Playwright or set AGH_PLAYWRIGHT_PACKAGE to its package folder. Use an existing Chromium cache.',
  )
if (!process.env.AGH_WEB_URL && !process.argv.includes('--list'))
  throw new Error('Set AGH_WEB_URL to the isolated test server URL.')
const child = spawnSync(
  process.execPath,
  [
    join(resolve(packagePath), 'cli.js'),
    'test',
    '--config',
    'tools/e2e-web/playwright.config.mjs',
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, AGH_PLAYWRIGHT_PACKAGE: resolve(packagePath) },
  },
)
process.exit(child.status ?? 1)
