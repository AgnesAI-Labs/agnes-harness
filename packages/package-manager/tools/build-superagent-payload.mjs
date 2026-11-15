#!/usr/bin/env node
// Bundle packages/superagent into the optional Superagent payload.
// packages/superagent stays the only source; the payload index.mjs and its prompts/, skills/ and locale/ copies are
// generated and not committed; so are the panel's src/client.js, its stylesheet and client-build.json (NOTICE is generated
// and committed).
import { copyFileSync, cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildPresentations } from '../../../tools/presentation-build.mjs'

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

/** The panel's sources: its stylesheets are copied next to the bundle under the names the descriptor lists. */
export const superagentPanelDirectory = join(packageManagerRoot, '..', 'superagent-ui', 'src')

/**
 * The browser panel: `src/client.js`, `NOTICE` and `client-build.json` from packages/superagent-ui, next to the committed
 * client descriptor, as the judgment payload does, and each stylesheet the descriptor lists. A directory other than the
 * payload gets a copy of the descriptor.
 */
export async function buildSuperagentPresentation(directory = superagentPayloadDirectory) {
  await buildPresentations({ outputDirectories: { superagent: directory }, names: ['superagent'] })
  mkdirSync(join(directory, 'src'), { recursive: true })
  const descriptor = join(superagentPayloadDirectory, 'src', 'agnes.client.json')
  if (directory !== superagentPayloadDirectory)
    copyFileSync(descriptor, join(directory, 'src', 'agnes.client.json'))
  for (const style of JSON.parse(readFileSync(descriptor, 'utf8')).client.styles ?? []) {
    const name = basename(style)
    copyFileSync(join(superagentPanelDirectory, name), join(directory, 'src', name))
  }
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
