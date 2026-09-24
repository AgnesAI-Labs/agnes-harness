import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Re-signs the frozen baseline. Changing minimal-rl.yaml is meant to be a deliberate act - a run
 * measured against it is only comparable to another run over the identical bytes - so the hash is
 * never regenerated as a side effect of loading or testing. This is the only thing that writes it.
 */
const dir = new URL('../presets/', import.meta.url)
const yaml = fileURLToPath(new URL('minimal-rl.yaml', dir))
const sha = fileURLToPath(new URL('minimal-rl.sha256', dir))
const digest = createHash('sha256').update(readFileSync(yaml)).digest('hex')
writeFileSync(sha, `${digest}\n`)
process.stdout.write(`minimal-rl.sha256 <- ${digest}\n`)
