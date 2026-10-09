// Downloads the assets listed in assets/manifest.json into assets/cache/ and checks the size and md5
// of every file. Files already present with the right hash are kept. Run by dev and start.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const md5 = (buf) => createHash('md5').update(buf).digest('hex')

const files = manifest.assets.flatMap((a) => a.files)
const missing = files.filter((f) => {
  const path = join(root, 'cache', f.path)
  return !existsSync(path) || md5(readFileSync(path)) !== f.md5
})
if (missing.length > 0)
  console.log(
    `fetching ${missing.length} of ${files.length} asset files (${(manifest.bytes / 1e6).toFixed(0)} MB in all)`,
  )
let done = 0
async function fetchOne(f) {
  const res = await fetch(f.url)
  if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length !== f.size || md5(buf) !== f.md5)
    throw new Error(`${f.path}: size or md5 does not match the manifest`)
  const path = join(root, 'cache', f.path)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buf)
  done += 1
  if (done % 20 === 0 || done === missing.length) console.log(`  ${done}/${missing.length}`)
}
const queue = [...missing]
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (queue.length > 0) await fetchOne(queue.shift())
  }),
)
