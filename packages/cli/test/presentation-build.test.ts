import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  buildPresentations,
  presentationRoot,
  verifyPresentation,
} from '../../../tools/presentation-build.mjs'
import { copyBundledPlugins } from '../tools/build-local.js'

it('rebuilds deterministic presentations, caches unchanged inputs and ships verifiable hashes', async () => {
  const records = await buildPresentations({ force: true })
  await buildPresentations({ check: true })
  const entry = join(presentationRoot, 'packages/package-manager/bundled-plugins/goal-ui/src/client.js')
  const before = await stat(entry)
  expect(await buildPresentations()).toEqual(records)
  expect((await stat(entry)).mtimeMs).toBe(before.mtimeMs)
  const output = await mkdtemp(join(tmpdir(), 'agh-presentation-build-'))
  try {
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
      await cp(
        join(presentationRoot, 'packages/package-manager/bundled-plugins', record.name, 'client-build.json'),
        join(payload, 'client-build.json'),
      )
      expect(await verifyPresentation(payload)).toEqual(record)
    }
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 30_000)
