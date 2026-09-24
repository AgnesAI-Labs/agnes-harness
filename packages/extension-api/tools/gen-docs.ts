import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateAll } from './gen-docs-core.js'

const docs = new URL('../docs/', import.meta.url)
const check = process.argv.includes('--check')
for (const [name, text] of Object.entries(generateAll())) {
  const file = new URL(name, docs)
  if (existsSync(file) && readFileSync(file, 'utf8') === text) continue
  if (check) {
    console.error(`stale: docs/${name}`)
    process.exitCode = 1
  } else {
    mkdirSync(fileURLToPath(docs), { recursive: true })
    writeFileSync(file, text)
  }
}
