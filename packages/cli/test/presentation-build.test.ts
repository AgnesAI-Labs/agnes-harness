import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWebDevBuild } from '@agnes/web/dev'
import { expect, it, vi } from 'vitest'
import * as presentationBuild from '../../../tools/presentation-build.mjs'
import {
  buildPresentations,
  presentationRoot,
  verifyPresentation,
} from '../../../tools/presentation-build.mjs'
import setupPresentations from '../../../tools/presentation-test-setup.mjs'
import { copyBundledPlugins } from '../tools/build-local.js'

it('rebuilds deterministic presentations, caches unchanged inputs and ships verifiable hashes', async () => {
  const output = await mkdtemp(join(tmpdir(), 'agh-presentation-build-'))
  const outputRoot = join(output, 'payloads')
  const sharedEntry = join(presentationRoot, 'packages/package-manager/bundled-plugins/goal-ui/src/client.js')
  const sharedBefore = await stat(sharedEntry)
  const compile = presentationBuild.buildPresentations
  // Exercise the real gate through every caller, but never poison another test's release source.
  const isolated = vi
    .spyOn(presentationBuild, 'buildPresentations')
    .mockImplementation((options) => compile({ ...options, outputRoot }))
  try {
    await cp(join(presentationRoot, 'packages/package-manager/bundled-plugins'), outputRoot, {
      recursive: true,
    })
    const records = await buildPresentations({ force: true })
    await buildPresentations({ check: true })
    const source = join(outputRoot, 'goal-ui')
    const entry = join(source, 'src/client.js')
    const before = await stat(entry)
    expect(await buildPresentations()).toEqual(records)
    expect((await stat(entry)).mtimeMs).toBe(before.mtimeMs)
    const originals = new Map(
      await Promise.all(
        ['src/client.js', 'NOTICE', 'client-build.json'].map(
          async (file) => [file, await readFile(join(source, file))] as const,
        ),
      ),
    )
    // A fresh checkout has no generated files; each source still generates without a prior record.
    for (const file of originals.keys()) await rm(join(source, file))
    expect(await buildPresentations()).toEqual(records)
    for (const [file, original] of originals) expect(await readFile(join(source, file))).toEqual(original)
    await copyBundledPlugins(output)
    for (const record of records) {
      const payload = join(output, 'bundled-plugins', record.name)
      expect(await verifyPresentation(payload)).toEqual(record)
      const recordFile = join(payload, 'client-build.json')
      const originalRecord = await readFile(recordFile)
      for (const changed of [
        { ...record, name: 'impostor' },
        { ...record, inputHash: 'invalid' },
        { ...record, inputs: ['../outside'] },
      ]) {
        await writeFile(recordFile, JSON.stringify(changed))
        await expect(verifyPresentation(payload)).rejects.toThrow('Invalid presentation build record')
      }
      await writeFile(recordFile, originalRecord)
      const original = await readFile(join(payload, 'src/client.js'))
      await writeFile(join(payload, 'src/client.js'), '// changed after packaging')
      await expect(verifyPresentation(payload)).rejects.toThrow('Presentation hash mismatch')
      await writeFile(join(payload, 'src/client.js'), original)
      await rm(join(payload, 'client-build.json'))
      await expect(verifyPresentation(payload)).rejects.toThrow()
      await cp(join(outputRoot, record.name, 'client-build.json'), join(payload, 'client-build.json'))
      expect(await verifyPresentation(payload)).toEqual(record)
    }
    // The review counterexample keeps source/inputHash unchanged and makes the payload self-consistent.
    const poisoned = Buffer.concat([
      await readFile(join(source, 'src/client.js')),
      Buffer.from('\n// forged output\n'),
    ])
    const forged = JSON.parse(await readFile(join(source, 'client-build.json'), 'utf8'))
    forged.bytes = poisoned.length
    forged.files['src/client.js'] = `sha256-${createHash('sha256').update(poisoned).digest('hex')}`
    await writeFile(join(source, 'src/client.js'), poisoned)
    await writeFile(join(source, 'client-build.json'), `${JSON.stringify(forged, null, 2)}\n`)
    expect((await verifyPresentation(source)).inputHash).toBe(forged.inputHash)
    for (const enter of [
      () => buildPresentations(),
      () => buildPresentations({ check: true }),
      () => buildPresentations({ force: true }),
      // build:local, build:sea and release:pack all enter this gate before copying bundled plugins.
      () => copyBundledPlugins(join(output, 'poisoned')),
      () => startWebDevBuild(),
      () => setupPresentations(),
    ]) {
      await expect(enter()).rejects.toThrow('Stale presentation build: goal-ui')
      expect(await readFile(join(source, 'src/client.js'))).toEqual(poisoned)
    }
    await expect(stat(join(output, 'poisoned', 'bundled-plugins', 'goal-ui'))).rejects.toThrow()
  } finally {
    isolated.mockRestore()
    await rm(output, { recursive: true, force: true })
    expect((await stat(sharedEntry)).mtimeMs).toBe(sharedBefore.mtimeMs)
  }
}, 30_000)
