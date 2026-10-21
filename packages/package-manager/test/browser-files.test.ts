import { lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { openFilePreview, localFile } = await import(
  new URL('../bundled-plugins/browser/src/files.mjs', import.meta.url).href
)

it('serves authorized native types and bounded ranges, rejects aliases and revokes delayed resources', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agh-file-preview-')))
  const directory = join(root, '中文 space')
  await mkdir(directory)
  let live = true,
    largest = 0
  const files = {
    async stat(path: string) {
      if (!live) throw new Error('revoked')
      const info = await lstat(path)
      return { kind: info.isFile() ? 'file' : 'dir', size: info.size, mtimeMs: info.mtimeMs }
    },
    async read(path: string, opts: { offset: number; limit: number }) {
      if (!live) throw new Error('revoked')
      largest = Math.max(largest, opts.limit)
      const file = await open(path, 'r')
      try {
        const bytes = Buffer.alloc(opts.limit)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, opts.offset)
        return bytes.subarray(0, bytesRead)
      } finally {
        await file.close()
      }
    },
  }
  const names = {
    'index.html': ['text/html; charset=utf-8', '<h1>预览</h1>'],
    'style.css': ['text/css; charset=utf-8', 'h1{color:red}'],
    'picture.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    'data.json': ['application/json', '{"hello":1}'],
    'document.pdf': ['application/pdf', '%PDF-1.4'],
    'audio.wav': ['audio/wav', 'RIFF'],
    'video.webm': ['video/webm', 'video'],
  }
  let preview: any
  try {
    for (const [name, [, text]] of Object.entries(names)) await writeFile(join(directory, name), text!)
    await writeFile(join(directory, '.env'), 'PRIVATE')
    await writeFile(join(root, 'outside.txt'), 'OUTSIDE')
    await writeFile(join(directory, 'large.txt'), Buffer.alloc(1024 * 1024, 65))
    const args = { value: pathToFileURL(join(directory, 'index.html')).href, root, files, assertCurrent() {} }
    preview = await openFilePreview(args)
    expect((await fetch(preview.url)).status).toBe(403)
    for (const [name, [mime, text]] of Object.entries(names)) {
      const response = await fetch(preview.origin + '/' + name, { headers: preview.headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(mime)
      expect(await response.text()).toBe(text)
    }
    for (const [name, hex, mime] of [
      ['unnamed', '89504e470d0a1a0a', 'image/png'],
      ['download.unknown', '255044462d312e34', 'application/pdf'],
      ['recording', '524946460000000057415645', 'audio/wav'],
      ['unicode', 'fffe61006200', 'text/plain'],
      [
        'unicode-boundary',
        Buffer.from('a'.repeat(4095) + '中文').toString('hex'),
        'text/plain; charset=utf-8',
      ],
    ]) {
      const path = join(directory, name!)
      await writeFile(path, Buffer.from(hex!, 'hex'))
      const detected = await openFilePreview({ ...args, value: path })
      try {
        const response = await fetch(detected.url, { headers: detected.headers })
        expect(response.headers.get('content-type')).toBe(mime)
        expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(hex!, 'hex'))
      } finally {
        detected.close()
      }
    }
    const invalidText = join(directory, 'invalid-utf8')
    await writeFile(invalidText, Buffer.concat([Buffer.alloc(4095, 65), Buffer.from([255])]))
    await expect(openFilePreview({ ...args, value: invalidText })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    })
    const range = await fetch(preview.origin + '/large.txt', {
      headers: { ...preview.headers, range: 'bytes=10-29' },
    })
    expect(range.status).toBe(206)
    expect(range.headers.get('content-range')).toBe('bytes 10-29/1048576')
    expect((await range.arrayBuffer()).byteLength).toBe(20)
    const all = await fetch(preview.origin + '/large.txt', { headers: preview.headers })
    expect((await all.arrayBuffer()).byteLength).toBe(1024 * 1024)
    expect(largest).toBeLessThanOrEqual(256 * 1024)
    for (const name of ['.env', '%2e%2e%2foutside.txt', 'bad%00name', '%5coutside.txt'])
      expect((await fetch(preview.origin + '/' + name, { headers: preview.headers })).status).toBe(403)
    expect(
      (await fetch(preview.url, { headers: { ...preview.headers, range: 'bytes=999999-' } })).status,
    ).toBe(416)
    await expect(openFilePreview({ ...args, value: join(root, '..', 'outside') })).rejects.toMatchObject({
      code: 'FILE_DENIED',
    })
    await symlink(root, join(directory, 'alias'), 'junction')
    expect((await fetch(preview.origin + '/alias/outside.txt', { headers: preview.headers })).status).toBe(
      403,
    )
    live = false
    expect((await fetch(preview.url, { headers: preview.headers })).status).toBe(403)
    for (const url of ['file://server/share/test.html', 'file:///test.html?query=1'])
      expect(() => localFile(url)).toThrow()
  } finally {
    preview?.close()
    await rm(root, { recursive: true, force: true })
  }
})
