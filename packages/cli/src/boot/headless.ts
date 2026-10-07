import { open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import * as host from '@agnes/host'
import type { ProfileInputs } from '@agnes/host'
import type { HeadlessRunBoot } from '../commands/run.js'
import { BootError, UsageError } from '../errors.js'
import { bootLocal, type LocalBootDeps } from './local.js'

// Consume Host composition exports through a narrow version boundary. Older Hosts fail closed;
// clients do not resolve, merge or validate plugin trees themselves.
type BundleCatalog = Readonly<Record<string, { id: string; sourcePackage: string; document: unknown }>>
type BundleInputs = ProfileInputs & { bundleCatalog?: BundleCatalog }
type CompositionPort = {
  parsePackageBundles(packageId: string, bundles: unknown): BundleCatalog
  expandBundles(ids: readonly string[], catalog: BundleCatalog): readonly unknown[]
}
function compositionHost(): CompositionPort {
  const port = host as unknown as Partial<CompositionPort>
  if (typeof port.parsePackageBundles !== 'function' || typeof port.expandBundles !== 'function')
    throw new BootError('headless --bundle requires a Host with bundle composition support')
  return port as CompositionPort
}
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
/** Apply a transient bundle through Host profile inputs; never write desired admin defaults. */
export async function bootHeadless(input: HeadlessRunBoot, deps: LocalBootDeps) {
  const composition = compositionHost()
  const isId =
    !isAbsolute(input.bundle) &&
    !input.bundle.startsWith('.') &&
    /^[^\s\x00-\x1f]+#[a-z][a-z0-9-]{0,63}$/.test(input.bundle)
  const document = isId ? undefined : await readBundle(resolve(deps.cwd, input.bundle))
  const additions = isId ? {} : composition.parsePackageBundles('headless', { run: document })
  const bundle = isId ? input.bundle : 'headless#run'
  return bootLocal(input.args, {
    ...deps,
    signal: input.signal,
    // This form is deliberately embedded: no launcher, web listener or shared daemon mutation.
    transformProfileInputs: async (original) => {
      const inputs = (
        deps.transformProfileInputs ? await deps.transformProfileInputs(original) : original
      ) as BundleInputs
      const bundleCatalog = { ...inputs.bundleCatalog, ...additions }
      composition.expandBundles([bundle], bundleCatalog)
      return { ...inputs, bundleCatalog, adminBundles: [bundle] } as ProfileInputs
    },
  })
}
