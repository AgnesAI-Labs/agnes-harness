// Vitest global setup: make sure the generated Jev payload entry exists and is newer than its source.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildJevPayload, jevPayloadDirectory } from './build-jev-payload.mjs'

const jevSourceDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'loop-jev', 'src')

const newestSource = (directory) =>
  readdirSync(directory, { withFileTypes: true }).reduce((newest, entry) => {
    const path = join(directory, entry.name)
    return Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs)
  }, 0)

/** Rebuild only when index.mjs is missing or older than any loop-jev source file. */
export async function ensureJevPayload() {
  const entry = join(jevPayloadDirectory, 'index.mjs')
  if (existsSync(entry) && statSync(entry).mtimeMs >= newestSource(jevSourceDirectory)) return
  await buildJevPayload()
}

export default ensureJevPayload
