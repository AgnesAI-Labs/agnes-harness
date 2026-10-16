import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyBundledPlugins } from './build-local.js'

// Source-mode defaults use the same isolated runtime payloads as local and SEA distributions.
const output = fileURLToPath(new URL('../../package-manager/dist/', import.meta.url))
await rm(join(output, 'bundled-plugins'), { recursive: true, force: true })
await copyBundledPlugins(output)
