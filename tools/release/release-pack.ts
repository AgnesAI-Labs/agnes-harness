#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardPackage } from './pack-guard.js'
import { packNpxPackage } from './pack-npx.js'
import { guardTarball } from './packed-tarball.js'

const repo = resolve(import.meta.dirname, '../..')

function npmPackCommand(): { bin: string; args: string[] } {
  if (process.platform !== 'win32') return { bin: 'npm', args: [] } // guards-allow-platform: npm.cmd cannot be execFile'd.
  const cli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  if (!existsSync(cli)) throw new Error('Windows packing requires Node with bundled npm')
  return { bin: process.execPath, args: [cli] }
}

/** A set with one self-contained CLI tarball for the build host; never publishes. */
export async function releasePack(
  output: string,
): Promise<{ tarball: string; triple: string; bytes: number; sha256: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agh-pack-'))
  try {
    const stage = join(root, 'stage')
    const { triple } = await packNpxPackage(stage)
    await guardPackage(stage, triple)
    await mkdir(output, { recursive: true })
    const npm = npmPackCommand()
    const packed = execFileSync(
      npm.bin,
      [...npm.args, 'pack', '--json', '--ignore-scripts', '--pack-destination', root],
      {
        cwd: stage,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          npm_config_offline: 'true',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
        },
      },
    )
    const [entry] = JSON.parse(packed) as { filename: string }[]
    if (!entry || dirname(entry.filename) !== '.')
      throw new Error('npm pack did not return a tarball filename')
    await guardTarball(join(root, entry.filename), triple)
    const bytes = await readFile(join(root, entry.filename))
    const result = {
      tarball: join(output, entry.filename),
      triple,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    await writeFile(result.tarball, bytes)
    await writeFile(join(output, 'pack-result.json'), `${JSON.stringify({ packages: [result] }, null, 2)}\n`)
    return result
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && !(args.length === 2 && args[0] === '--output' && isAbsolute(args[1] ?? '')))
    throw new Error('Expected no arguments or --output with an absolute directory')
  process.stdout.write(
    `${JSON.stringify(await releasePack(args[1] ?? join(repo, 'dist/release')), null, 2)}\n`,
  )
}
