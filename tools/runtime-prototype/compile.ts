import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { CHECKPOINT_FILES, digestFiles, GENERATED_FILES, jsonDigest, SOURCE_FILES } from './files.js'

export function compilePrototype(root: string) {
  const checkout = realpathSync(root)
  const args = [
    'node_modules/typescript/bin/tsc',
    '--project',
    'tools/runtime-prototype/tsconfig.compile.json',
    '--pretty',
    'false',
    '--listFiles',
  ]
  const result = spawnSync(process.execPath, args, {
    cwd: checkout,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.status !== 0)
    throw new Error(
      `public prototype API compilation failed:\n${result.error?.message ?? `${result.stdout}\n${result.stderr}`}`,
    )
  const projectFiles = result.stdout
    .split(/\r?\n/)
    .filter((path) => path.startsWith(`${checkout}/`) || path.startsWith(`${checkout}\\`))
    .map((path) => relative(checkout, path).replaceAll('\\', '/'))
    .filter((path) => !path.split('/').includes('node_modules'))
  if (!projectFiles.includes('packages/extension-api/test/runtime/prototype-consumer.compile.ts'))
    throw new Error('compiler did not include the public API consumer')
  const packageManifests = new Set<string>()
  for (const path of projectFiles) {
    const owner = /^packages\/([^/]+)\//.exec(path)
    if (!owner) continue
    const manifest = `packages/${owner[1]}/package.json`
    if (!existsSync(resolve(checkout, manifest)))
      throw new Error(`compiled workspace package is missing its manifest: ${manifest}`)
    packageManifests.add(manifest)
  }
  const compiler = JSON.parse(
    readFileSync(resolve(checkout, 'node_modules/typescript/package.json'), 'utf8'),
  ) as { version: string }
  const inputs = digestFiles(checkout, [
    ...projectFiles,
    ...packageManifests,
    ...SOURCE_FILES,
    ...GENERATED_FILES,
    ...CHECKPOINT_FILES,
  ])
  const report = {
    compiler: 'typescript',
    compilerVersion: compiler.version,
    command: ['node', ...args],
    inputs,
    inputDigest: jsonDigest(inputs),
    diagnostics: [],
  }
  return { ...report, reportDigest: jsonDigest(report) }
}
