#!/usr/bin/env node
// Bundle packages/superagent into the optional Superagent payload.
// packages/superagent stays the only source; the payload index.mjs and its prompts/, skills/ and locale/ copies are
// generated and not committed.
import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageManagerRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const superagentPayloadDirectory = join(packageManagerRoot, 'bundled-plugins', 'superagent')
export const superagentSourceDirectory = join(packageManagerRoot, '..', 'superagent')
/** The folders the plugin reads next to its entry at run time. */
export const SUPERAGENT_RESOURCE_FOLDERS = Object.freeze(['prompts', 'skills', 'locale'])

/** Replace one generated folder in the payload; a stale file left by a removed source file does not survive. */
function copyResource(name, directory) {
  const target = join(directory, name)
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    cpSync(join(superagentSourceDirectory, name), temporary, { recursive: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/**
 * The browser panel. Its source package does not exist yet; once it does, its build output is written here into
 * `src/` together with the client descriptor, as the judgment payload does.
 */
export async function buildSuperagentPresentation(_directory = superagentPayloadDirectory) {
  if (!existsSync(join(packageManagerRoot, '..', 'superagent-ui'))) return
  throw new Error('packages/superagent-ui exists: add its presentation build to build-superagent-payload.mjs')
}

/**
 * Write `index.mjs` and the resource folders into the payload directory; host-provided modules stay external. The
 * entry is replaced in one rename, so a concurrent reader sees the old or the new bundle, never a torn one.
 */
export async function buildSuperagentPayload(directory = superagentPayloadDirectory) {
  await buildSuperagentPresentation(directory)
  for (const name of SUPERAGENT_RESOURCE_FOLDERS) copyResource(name, directory)
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const entry = join(directory, 'index.mjs')
  const result = await build({
    entryPoints: [join(superagentSourceDirectory, 'src', 'index.ts')],
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildSuperagentPayload()
