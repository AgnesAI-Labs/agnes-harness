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
    'web-quality': 'success',
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'select') {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `web=${ciWebSelected(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF)}\n`,
    )
  } else {
    verifyWebResults(JSON.parse(process.env.CI_NEEDS), {
      externalFast: process.env.EXTERNAL_FAST === 'true',
      externalHeavy: process.env.EXTERNAL_HEAVY === 'true',
    })
  }
}
