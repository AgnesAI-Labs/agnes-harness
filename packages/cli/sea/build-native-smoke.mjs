// Build only the native-runtime compatibility probe, without production UI or plugin bundles.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postject from 'postject'

const output = process.argv[2]
if (!output || !isAbsolute(output)) throw new Error('Expected an absolute output directory')
mkdirSync(output, { recursive: true })
const source = join(output, 'crypto-smoke.cjs')
const blob = join(output, 'crypto-smoke.blob')
const config = join(output, 'crypto-smoke.json')
const binary = join(output, 'crypto-smoke')
copyFileSync(fileURLToPath(new URL('../../../tools/native/crypto-smoke.cjs', import.meta.url)), source)
writeFileSync(config, JSON.stringify({ main: source, output: blob, disableExperimentalSEAWarning: true }))
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' })
copyFileSync(process.execPath, binary)
await postject.inject(binary, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
})
chmodSync(binary, 0o755)
for (const path of [source, blob, config]) rmSync(path)
console.log(`Built native runtime smoke with ${process.version}: ${binary}`)
