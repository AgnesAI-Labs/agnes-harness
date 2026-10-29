import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { notices } from './presentation-notices.mjs'
import { assertClientExternals, clientPlatformExternals } from './web-client-externals.mjs'

export const presentationRoot = fileURLToPath(new URL('../', import.meta.url))
export const presentationEntries = {
  browser: 'packages/package-manager/bundled-plugins/browser/src/browser.tsx',
  'goal-ui': 'packages/package-manager/bundled-plugins/goal-ui/src/presentation.tsx',
  'interaction-ui': 'packages/package-manager/bundled-plugins/interaction-ui/src/presentation.ts',
  'navigation-ui': 'packages/package-manager/bundled-plugins/navigation-ui/src/presentation.ts',
  'conversation-ui': 'packages/package-manager/bundled-plugins/conversation-ui/src/presentation.ts',
  'deliverables-ui': 'packages/package-manager/bundled-plugins/deliverables-ui/src/client-entry.mjs',
}
const require = createRequire(join(presentationRoot, 'packages/web/package.json'))
const { build, version: esbuildVersion } = require('esbuild')
const digest = (bytes) => `sha256-${createHash('sha256').update(bytes).digest('hex')}`
const json = (data) => `${JSON.stringify(data, null, 2)}\n`
const defaultOutputRoot = join(presentationRoot, 'packages/package-manager/bundled-plugins')

async function inputHash(inputs) {
  const paths = new Set([
    'pnpm-lock.yaml',
    'package.json',
    '.node-version',
    'tools/presentation-build.mjs',
    'tools/presentation-notices.mjs',
    'tools/web-client-externals.mjs',
    'packages/web/public/index.html',
    ...inputs,
  ])
  // Hash resolution metadata only for actual input owners. Shared platform implementation
  // changes must not change a plugin's input digest or its trust identity.
  for (const input of inputs) {
    let directory = dirname(input)
    while (directory !== '.') {
      const manifest = join(directory, 'package.json').replaceAll('\\', '/')
      try {
        await readFile(join(presentationRoot, manifest))
        paths.add(manifest)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      directory = dirname(directory)
    }
  }
  const hash = createHash('sha256').update(`presentation-v1:${esbuildVersion}\0`)
  for (const path of [...paths].sort())
    hash
      .update(path)
      .update('\0')
      .update(await readFile(join(presentationRoot, path)))
      .update('\0')
  return `sha256-${hash.digest('hex')}`
}
async function atomicWrite(path, bytes) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, bytes)
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}
/** Checks payload consistency, not whether editable build outputs correspond to source. */
export async function verifyPresentation(root) {
  const record = JSON.parse(await readFile(join(root, 'client-build.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (
    record.schemaVersion !== 1 ||
    !Object.hasOwn(presentationEntries, record.name) ||
    manifest.name !== `@agnes/${record.name}` ||
    record.entry !== presentationEntries[record.name] ||
    !/^sha256-[a-f0-9]{64}$/.test(record.inputHash) ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 1 ||
    !Array.isArray(record.inputs) ||
    !record.inputs.includes(record.entry) ||
    record.inputs.some(
      (path) =>
        typeof path !== 'string' ||
        path.includes('\\') ||
        path.includes('\0') ||
        path.startsWith('/') ||
        path.includes(':') ||
        path.split('/').some((part) => part === '..' || part === '.'),
    )
  )
    throw new Error(`Invalid presentation build record: ${root}`)
  for (const name of ['src/client.js', 'NOTICE']) {
    const bytes = await readFile(join(root, name))
    if (record.files?.[name] !== digest(bytes) || (name === 'src/client.js' && bytes.length !== record.bytes))
      throw new Error(`Presentation hash mismatch: ${root}/${name}`)
  }
  return record
}

/** Independently compile before accepting cached bytes. Only source changes or missing outputs rebuild. */
export async function buildPresentations({
  check = false,
  force = false,
  outputRoot = defaultOutputRoot,
} = {}) {
  const results = []
  let createdForCheck = false
  for (const [name, entry] of Object.entries(presentationEntries)) {
    const root = join(outputRoot, name)
    let previous
    try {
      previous = await verifyPresentation(root)
    } catch (error) {
      const recorded = await readFile(join(root, 'client-build.json')).then(
        () => true,
        (failure) => {
          if (failure.code !== 'ENOENT') throw failure
          return false
        },
      )
      if (check && (recorded || error.code !== 'ENOENT')) throw error
    }
    const result = await build({
      absWorkingDir: presentationRoot,
      entryPoints: [entry],
      outfile: join(root, 'src/client.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2023',
      jsx: 'automatic',
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      nodePaths: [join(presentationRoot, 'packages/web/node_modules')],
      plugins: [clientPlatformExternals],
      minify: true,
      legalComments: 'eof',
      write: false,
      metafile: true,
    })
    assertClientExternals(result.metafile)
    const output = `// Generated by tools/build-feature-clients.mjs. Edit the source, then regenerate.\n${result.outputFiles[0].text}`
    const notice = await notices(presentationRoot, result.metafile.inputs)
    const inputs = Object.keys(result.metafile.inputs)
      .map((path) => path.replaceAll('\\', '/'))
      .sort()
    const record = {
      schemaVersion: 1,
      name,
      entry,
      esbuildVersion,
      inputHash: await inputHash(inputs),
      inputs,
      bytes: Buffer.byteLength(output),
      files: { 'src/client.js': digest(output), NOTICE: digest(notice) },
    }
    // Neither inputHash nor output hashes in an editable record prove source correspondence.
    // A current-input cache must match this independent compilation, even for dev/test and force.
    if (previous && (check || previous.inputHash === record.inputHash)) {
      if (json(record) !== json(previous)) throw new Error(`Stale presentation build: ${name}`)
      if (check || !force) {
        results.push(record)
        continue
      }
    }
    await atomicWrite(join(root, 'src/client.js'), output)
    await atomicWrite(join(root, 'NOTICE'), notice)
    await atomicWrite(join(root, 'client-build.json'), json(record))
    if (check) createdForCheck = true
    results.push(record)
  }
  return createdForCheck ? buildPresentations({ check: true, outputRoot }) : results
}
