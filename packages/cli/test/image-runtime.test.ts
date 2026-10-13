import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { copyImageRuntime } from '../tools/image-runtime.js'

// The CLI package does not depend on sharp; describe only the calls made here.
type Sharp = (
  input: Buffer | { create: { width: number; height: number; channels: 3; background: string } },
) => {
  png(): { toBuffer(): Promise<Buffer> }
  metadata(): Promise<{ width?: number }>
}

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('copies sharp with its platform codec so a bundled worker beside it can load it', async () => {
  const out = mkdtempSync(join(tmpdir(), 'agh-image-runtime-'))
  made.push(out)
  await copyImageRuntime(out)
  expect(existsSync(join(out, 'node_modules', 'sharp', 'package.json'))).toBe(true)
  expect(readdirSync(join(out, 'node_modules', '@img')).some((name) => name.startsWith('sharp-'))).toBe(true)
  const sharp = createRequire(join(out, 'worker.mjs'))('sharp') as Sharp
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#808080' } })
    .png()
    .toBuffer()
  expect((await sharp(png).metadata()).width).toBe(4)
}, 60_000)
