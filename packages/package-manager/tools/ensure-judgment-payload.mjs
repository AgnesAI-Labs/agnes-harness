// Vitest global setup: make sure the generated Judgment payload entry exists and is newer than its source.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildJudgmentPayload,
  buildJudgmentPresentation,
  judgmentPayloadDirectory,
} from './build-judgment-payload.mjs'

const judgmentSourceDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'judgment', 'src')

const newestSource = (directory) =>
  readdirSync(directory, { withFileTypes: true }).reduce((newest, entry) => {
    const path = join(directory, entry.name)
    return Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs)
  }, 0)

/** Rebuild only when index.mjs is missing or older than any judgment source file. */
export async function ensureJudgmentPayload(directory = judgmentPayloadDirectory) {
  await buildJudgmentPresentation(directory)
  const entry = join(directory, 'index.mjs')
  const newest = Math.max(
    newestSource(judgmentSourceDirectory),
    statSync(join(directory, 'package.json')).mtimeMs,
    statSync(fileURLToPath(import.meta.url)).mtimeMs,
    statSync(fileURLToPath(new URL('./build-judgment-payload.mjs', import.meta.url))).mtimeMs,
  )
  if (existsSync(entry) && statSync(entry).mtimeMs >= newest) return
  await buildJudgmentPayload(directory)
}

export default async function setup() {
  await ensureJudgmentPayload()
}
