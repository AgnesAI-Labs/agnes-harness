import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = 'agnes-schema.mjs'

async function assertOwnedOutput(output) {
  if (!existsSync(output)) return
  if (!(await lstat(output)).isDirectory()) throw new Error('CLI output must be a directory')
  const names = await readdir(output)
  if (names.length === 0) return
  if (
    names.sort().join(',') !== 'LICENSE,THIRD-PARTY-NOTICES,agnes-schema.mjs' ||
    !(await lstat(join(output, entry))).isFile() ||
    !(await lstat(join(output, 'LICENSE'))).isFile() ||
    !(await lstat(join(output, 'THIRD-PARTY-NOTICES'))).isDirectory() ||
    (await readdir(join(output, 'THIRD-PARTY-NOTICES'))).join(',') !== 'typebox.txt' ||
    !(await lstat(join(output, 'THIRD-PARTY-NOTICES/typebox.txt'))).isFile()
  )
    throw new Error('CLI output contains files outside the build artifact')
}

async function typeboxLicense() {
  const require = createRequire(import.meta.url)
  let directory = dirname(require.resolve('@sinclair/typebox'))
  while (directory !== dirname(directory)) {
    const metadata = join(directory, 'package.json')
    if (existsSync(metadata)) {
      const value = JSON.parse(await readFile(metadata, 'utf8'))
      if (value.name === '@sinclair/typebox') {
        if (value.version !== '0.34.33') throw new Error('Unexpected bundled TypeBox version')
        return join(directory, 'license')
      }
    }
    directory = dirname(directory)
  }
  throw new Error('Bundled TypeBox license is missing')
}

/** Build the workspace command as a movable Node ESM artifact with only builtin imports. */
export async function buildAuthorSchemaCli(outputDirectory = join(protocolRoot, 'dist/schema-cli')) {
  const output = resolve(outputDirectory)
  await assertOwnedOutput(output)
  const parent = dirname(output)
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(join(parent, '.schema-cli-stage-'))
  let backup
  try {
    const artifact = join(staging, entry)
    const result = await build({
      absWorkingDir: protocolRoot,
      entryPoints: ['tools/gen-author-schema.ts'],
      outfile: artifact,
      bundle: true,
      packages: 'bundle',
      platform: 'node',
      format: 'esm',
      target: ['node24.10'],
      metafile: true,
      sourcemap: false,
      legalComments: 'inline',
      banner: { js: '#!/usr/bin/env node' },
      logLevel: 'silent',
    })
    if (
      Object.values(result.metafile.outputs).some((item) =>
        item.imports.some((dependency) => !dependency.external || !isBuiltin(dependency.path)),
      )
    )
      throw new Error('CLI artifact has a non-builtin runtime import')
    if (
      Object.keys(result.metafile.inputs).some(
        (input) => input.includes('node_modules/') && !input.includes('/@sinclair/typebox/'),
      )
    )
      throw new Error('CLI artifact contains an unaccounted third-party dependency')
    await copyFile(join(protocolRoot, '../../LICENSE'), join(staging, 'LICENSE'))
    await mkdir(join(staging, 'THIRD-PARTY-NOTICES'))
    await copyFile(await typeboxLicense(), join(staging, 'THIRD-PARTY-NOTICES/typebox.txt'))
    await chmod(artifact, 0o755)
    const bytes = await readFile(artifact)
    const digest = createHash('sha256').update(bytes).digest('hex')
    await assertOwnedOutput(output)
    if (existsSync(output)) {
      backup = await mkdtemp(join(parent, '.schema-cli-backup-'))
      await rm(backup, { recursive: true })
      await rename(output, backup)
    }
    try {
      await rename(staging, output)
    } catch (error) {
      if (backup) await rename(backup, output)
      throw error
    }
    if (backup) {
      try {
        await rm(backup, { recursive: true })
      } catch {
        process.stderr.write('CLI build succeeded; previous artifact backup could not be removed\n')
      }
    }
    return { entry: join(output, entry), bytes: bytes.length, digest }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

const invoked =
  process.argv[1] &&
  existsSync(resolve(process.argv[1])) &&
  import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href
if (invoked) {
  try {
    await buildAuthorSchemaCli()
  } catch {
    process.stderr.write('Author schema CLI build failed\n')
    process.exitCode = 1
  }
}
