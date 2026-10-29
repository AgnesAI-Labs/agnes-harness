import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { type BundleCatalog, expandBundles, type ProfileInputs, parsePackageBundles } from '@agnes/host'
import type { HeadlessRunBoot } from '../commands/run.js'
import { UsageError } from '../errors.js'
import { bootLocal, type LocalBootDeps } from './local.js'

async function readBundle(path: string): Promise<unknown> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new UsageError('bundle document must be a JSON file of at most 1 MiB')
    const bytes = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > info.size) throw new UsageError('bundle changed while reading')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } finally {
    await file.close()
  }
}
/** Read static bundle data using Host's public format; executable package loading stays in Host. */
export async function loadHeadlessBundle(
  specifier: string,
  cwd: string,
): Promise<{ id: string; catalog: BundleCatalog }> {
  const isId =
    !isAbsolute(specifier) &&
    !specifier.startsWith('.') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes at the identifier or path boundary.
    /^[^\s\x00-\x1f]+#[a-z][a-z0-9-]{0,63}$/.test(specifier)
  if (isId) return { id: specifier, catalog: {} }
  const document = await readBundle(resolve(cwd, specifier))
  return { id: 'headless#run', catalog: parsePackageBundles('headless', { run: document }) }
}
export function applyHeadlessBundle(
  inputs: ProfileInputs,
  bundle: { id: string; catalog: BundleCatalog },
): ProfileInputs {
  const bundleCatalog = { ...inputs.bundleCatalog, ...bundle.catalog }
  expandBundles([bundle.id], bundleCatalog)
  return { ...inputs, bundleCatalog, adminBundles: [bundle.id] }
}
/** Apply a transient bundle through Host profile inputs; never write desired admin defaults. */
export async function bootHeadless(input: HeadlessRunBoot, deps: LocalBootDeps) {
  const bundle = await loadHeadlessBundle(input.bundle, deps.cwd)
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'agh-headless-'))
  try {
    const boot = await bootLocal(input.args, {
      ...deps,
      runtimeDirectory,
      signal: input.signal,
      // This form is deliberately embedded: no launcher or web listener; shared session state and generation pins stay isolated.
      transformProfileInputs: async (original) =>
        applyHeadlessBundle(
          deps.transformProfileInputs ? await deps.transformProfileInputs(original) : original,
          bundle,
        ),
    })
    return {
      ...boot,
      close: async () => {
        try {
          await boot.close()
        } finally {
          await rm(runtimeDirectory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await rm(runtimeDirectory, { recursive: true, force: true })
    throw error
  }
}
