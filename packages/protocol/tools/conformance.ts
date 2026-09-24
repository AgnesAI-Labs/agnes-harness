import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findFixtureFiles, runFixtureFiles } from './conformance-core.js'

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const r = runFixtureFiles(findFixtureFiles(root))
for (const f of r.failed) console.error(`FAIL ${f.id}: ${f.detail}`)
console.log(`${r.total - r.failed.length}/${r.total} fixtures passed, ${r.skipped} skipped`)
process.exit(r.failed.length ? 1 : 0)
