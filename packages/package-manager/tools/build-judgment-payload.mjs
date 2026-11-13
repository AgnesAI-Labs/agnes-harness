#!/usr/bin/env node
// Bundle packages/judgment into the optional judgment payload.
// judgment stays the only source; the payload index.mjs is generated and not committed.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageManagerRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const judgmentPayloadDirectory = join(packageManagerRoot, 'bundled-plugins', 'judgment')
const judgmentSource = join(packageManagerRoot, '..', 'judgment', 'src', 'index.ts')

/**
 * Write `index.mjs` into the payload directory; host-provided modules stay external. The file is
 * replaced in one rename, so a concurrent reader sees the old or the new bundle, never a torn one.
 */
export async function buildJudgmentPayload(directory = judgmentPayloadDirectory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const entry = join(directory, 'index.mjs')
  const result = await build({
    entryPoints: [judgmentSource],
    outfile: entry,
    write: false,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node24'],
    external: Object.keys(manifest.agnes?.hostProvidedExternals ?? {}),
    legalComments: 'none',
    logLevel: 'warning',
  })
  const temporary = `${entry}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, result.outputFiles[0].contents)
    renameSync(temporary, entry)
  } finally {
    rmSync(temporary, { force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildJudgmentPayload()
