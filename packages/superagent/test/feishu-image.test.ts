// Adapted from dsh-superagent (MIT)
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { admissionImageKeys, readAdmissionImage } from '../src/sources/feishu-image.js'
import { fakeCli, message } from './sources/fake-cli.js'

it('reads only a scoped message image, enforces bounds and removes temporary downloads on success or failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'feishu-image-'))
  try {
    const fake = fakeCli({ history: [message('om_1', { text: '[image img_demo]' })] })
    const source = fake.lark.getMockImplementation()!
    let outside = false
    fake.lark.mockImplementation(async (args, cwd, input) => {
      if (args[1] !== '+messages-resources-download') return source(args, cwd, input)
      const path = join(outside ? root : cwd!, 'image.png')
      writeFileSync(path, new Uint8Array([1, 2, 3]))
      return { saved_path: path }
    })
    const sink = { check: vi.fn(async () => ({ maxBytes: 4 })), save: vi.fn(async () => ({ id: 'saved' })) }
    const io = { ...fake.io, stateDir: root }
    const ref = { triggerId: 't1', chatId: 'oc_team', messageId: 'om_1' }
    expect(admissionImageKeys('img_demo img_demo img_second')).toEqual(['img_demo', 'img_second'])
    expect(await readAdmissionImage(sink, io, ref, '[image img_demo]', 'img_demo')).toMatchObject({
      image: { id: 'saved' },
    })
    expect(readdirSync(root)).toEqual([])
    await expect(readAdmissionImage(sink, io, ref, 'img_demo', 'img_other')).rejects.toThrow(
      'Choose an image key',
    )
    sink.check.mockResolvedValue({ maxBytes: 2 })
    await expect(readAdmissionImage(sink, io, ref, 'img_demo', 'img_demo')).rejects.toThrow('byte limit')
    expect(readdirSync(root)).toEqual([])
    outside = true
    await expect(readAdmissionImage(sink, io, ref, 'img_demo', 'img_demo')).rejects.toThrow(
      'outside its temporary directory',
    )
    expect(readdirSync(root)).toEqual(['image.png'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
