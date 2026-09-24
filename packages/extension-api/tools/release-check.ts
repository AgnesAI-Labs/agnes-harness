import { readFileSync } from 'node:fs'
import * as api from '../src/index.js'
import { releaseProblems } from './release-check-core.js'

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const problems = releaseProblems({
  version: api.API_VERSION,
  packageVersion: JSON.parse(read('package.json')).version,
  changelog: read('docs/CHANGELOG.md'),
  surface: JSON.parse(read('api-surface.json')),
  runtimeExports: Object.keys(api),
})
for (const problem of problems) console.error(`release-check: ${problem}`)
if (problems.length) process.exitCode = 1
