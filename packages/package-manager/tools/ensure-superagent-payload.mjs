// Vitest global setup: make sure the generated Superagent payload exists and is newer than its source.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSuperagentPayload,
  SUPERAGENT_RESOURCE_FOLDERS,
  superagentPayloadDirectory,
  superagentSourceDirectory,
} from './build-superagent-payload.mjs'

const newestSource = (directory) =>
  readdirSync(directory, { withFileTypes: true }).reduce((newest, entry) => {
    const path = join(directory, entry.name)
    return Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs)
  }, statSync(directory).mtimeMs)

/** Rebuild only when the entry or a resource folder is missing or older than any source file. */
export async function ensureSuperagentPayload(directory = superagentPayloadDirectory) {
  const entry = join(directory, 'index.mjs')
  const newest = Math.max(
    ...['src', ...SUPERAGENT_RESOURCE_FOLDERS].map((name) =>
      newestSource(join(superagentSourceDirectory, name)),
    ),
    statSync(join(directory, 'package.json')).mtimeMs,
    statSync(fileURLToPath(import.meta.url)).mtimeMs,
    statSync(fileURLToPath(new URL('./build-superagent-payload.mjs', import.meta.url))).mtimeMs,
  )
  const fresh =
    existsSync(entry) &&
    statSync(entry).mtimeMs >= newest &&
    SUPERAGENT_RESOURCE_FOLDERS.every((name) => existsSync(join(directory, name)))
  if (!fresh) await buildSuperagentPayload(directory)
}

export default async function setup() {
  await ensureSuperagentPayload()
}
