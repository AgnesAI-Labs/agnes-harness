import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function ciWebSelected(event, ref) {
  return event === 'pull_request' || (event === 'push' && ref === 'refs/heads/main')
}

export function verifyWebResults(needs, { externalFast = false, externalHeavy = false } = {}) {
  const selected = {
    'web-types': 'success',
    'web-native-linux': 'success',
    'web-native-macos': 'success',
    'web-local-linux': 'success',
    'web-local-macos': 'success',
    'web-quality-linux': 'success',
    'web-quality-macos': 'success',
    'e2e-web': 'success',
    'e2e-web-linux': 'success',
    'linux-contracts': 'success',
    'linux-fast': externalFast ? 'skipped' : 'success',
    'linux-migrated-heavy': externalHeavy ? 'skipped' : 'success',
  }
  for (const [job, result] of Object.entries(selected)) {
    if (needs[job]?.result !== result)
      throw new Error(`${job}: expected ${result}, received ${needs[job]?.result ?? 'missing'}`)
  }
}

export function verifyPlatformResults(needs, layer, event) {
  if (
    !['check', 'heavy'].includes(layer) ||
    !['pull_request', 'push', 'schedule', 'workflow_dispatch'].includes(event)
  )
    throw new Error('Invalid platform validation mode')
  if (needs.changes?.result !== 'success' || needs.changes?.outputs?.['docs-only'] !== 'false')
    throw new Error('Missing full-validation classification')
  for (const platform of ['linux', 'macos', 'windows']) {
    const job = `${layer}-${platform}`
    const expected =
      layer === 'heavy' && event === 'pull_request' && platform !== 'linux' ? 'skipped' : 'success'
    if (needs[job]?.result !== expected)
      throw new Error(`${job}: expected ${expected}, received ${needs[job]?.result ?? 'missing'}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'select') {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `web=${ciWebSelected(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF)}\n`,
    )
  } else if (process.argv[2] === 'platforms') {
    verifyPlatformResults(
      JSON.parse(process.env.CI_NEEDS),
      process.env.PLATFORM_LAYER,
      process.env.GITHUB_EVENT_NAME,
    )
  } else {
    verifyWebResults(JSON.parse(process.env.CI_NEEDS), {
      externalFast: process.env.EXTERNAL_FAST === 'true',
      externalHeavy: process.env.EXTERNAL_HEAVY === 'true',
    })
  }
}
