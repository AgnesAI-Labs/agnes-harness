import { pathToFileURL } from 'node:url'

export function verifyResults(needs, event) {
  const docsOnly = needs.changes?.outputs?.['docs-only']
  if (!['true', 'false'].includes(docsOnly)) throw new Error('Missing or invalid change classification')
  if (!['pull_request', 'push', 'schedule', 'workflow_dispatch'].includes(event))
    throw new Error('Missing or invalid event name')

  const expected = {
    changes: 'success',
    static: 'success',
    check: docsOnly === 'true' ? 'skipped' : 'success',
    'windows-check-result': docsOnly === 'true' ? 'skipped' : 'success',
    heavy: docsOnly === 'true' ? 'skipped' : 'success',
    // Pull requests run the Windows ACL files in their own job; other events run the Windows heavy shards.
    'windows-acl': docsOnly === 'false' && event === 'pull_request' ? 'success' : 'skipped',
    'runtime-package': docsOnly === 'true' ? 'skipped' : 'success',
    sea: docsOnly === 'true' ? 'skipped' : 'success',
  }
  const webSelected = needs.changes?.outputs?.web
  if (!['true', 'false'].includes(webSelected)) throw new Error('Missing or invalid Web selection')
  Object.assign(expected, {
    'native-linux': 'success',
    'local-linux': 'success',
    'local-macos': docsOnly === 'true' ? 'skipped' : 'success',
    'local-windows': docsOnly === 'true' ? 'skipped' : 'success',
    'native-macos': docsOnly === 'true' ? 'skipped' : 'success',
    'native-windows': docsOnly === 'true' ? 'skipped' : 'success',
    'linux-fast': docsOnly === 'true' ? 'skipped' : 'success',
    web: webSelected === 'true' ? 'success' : 'skipped',
    'web-result': webSelected === 'true' ? 'success' : 'skipped',
    'browser-acceptance': webSelected === 'true' ? 'success' : 'skipped',
  })
  for (const [job, result] of Object.entries(expected)) {
    if (needs[job]?.result !== result) {
      throw new Error(`${job}: expected ${result}, received ${needs[job]?.result ?? 'missing'}`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyResults(JSON.parse(process.env.CI_NEEDS), process.env.GITHUB_EVENT_NAME)
  console.log('All required jobs passed; only documentation-only skips are accepted.')
}
