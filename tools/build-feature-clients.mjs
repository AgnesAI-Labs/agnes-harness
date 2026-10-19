import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPresentations } from './presentation-build.mjs'

export { buildPresentations } from './presentation-build.mjs'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildPresentations({ check: process.argv.includes('--check') })
