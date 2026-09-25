import { pathToFileURL } from 'node:url'

export function verifyResults(needs) {
  const docsOnly = needs.changes?.outputs?.['docs-only']
  if (!['true', 'false'].includes(docsOnly)) throw new Error('Missing or invalid change classification')

  const expected = {
    changes: 'success',
    static: 'success',
    check: docsOnly === 'true' ? 'skipped' : 'success',
    heavy: docsOnly === 'true' ? 'skipped' : 'success',
    'runtime-package': docsOnly === 'true' ? 'skipped' : 'success',
    sea: docsOnly === 'true' ? 'skipped' : 'success',
  }
  for (const [job, result] of Object.entries(expected)) {
    if (needs[job]?.result !== result) {
      throw new Error(`${job}: expected ${result}, received ${needs[job]?.result ?? 'missing'}`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyResults(JSON.parse(process.env.CI_NEEDS))
  console.log('All required jobs passed; only documentation-only skips are accepted.')
}
