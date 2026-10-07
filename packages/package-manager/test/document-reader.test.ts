import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { docx, zip } from './fixtures/document-reader.js'

type Parsed = { format: string; text: string; note: string }
const { parseDocument } = (await import(
  new URL('../bundled-plugins/document-reader/src/engine.mjs', import.meta.url).href
)) as {
  parseDocument(bytes: Uint8Array, args: { entry?: string; mimeType?: string }, assets?: URL): Promise<Parsed>
}
const { textPage } = (await import(
  new URL('../bundled-plugins/document-reader/src/page.mjs', import.meta.url).href
)) as {
  textPage(result: Parsed, options: { offset?: number; limit?: number }, budget: number): string
}

it('extracts Chinese DOCX tables and real legacy DOC text without Office', async () => {
  expect(await parseDocument(docx(), {})).toMatchObject({
    format: 'docx',
    text: expect.stringContaining('你好 DOCUMENT'),
  })
  expect((await parseDocument(docx(), {})).text).toContain('table cell')
  const legacy = await readFile(new URL('./fixtures/document-reader/legacy.doc', import.meta.url))
  expect(await parseDocument(legacy, {})).toMatchObject({
    format: 'doc',
    text: expect.stringContaining('Unicode characters'),
  })
  expect((await parseDocument(legacy, {})).text).toContain('😀 ∀')
})

it('lists ZIP entries and reads only the selected text or document', async () => {
  const bytes = zip([
    { name: 'nested/report.docx', data: docx() },
    { name: 'readme.md', data: Buffer.from('hello 皇上') },
  ])
  const listing = await parseDocument(bytes, {})
  expect(listing.text).toContain('nested/report.docx')
  expect(listing.text).not.toContain('你好 DOCUMENT')
  expect((await parseDocument(bytes, { entry: 'nested/report.docx' })).text).toContain('你好 DOCUMENT')
  expect((await parseDocument(bytes, { entry: 'readme.md' })).text).toBe('hello 皇上')
  await expect(parseDocument(bytes, { entry: 'missing' })).rejects.toMatchObject({
    code: 'ZIP_ENTRY_NOT_FOUND',
  })
  const ordinaryZip = zip([{ name: 'word/document.xml', data: Buffer.from('<report>plain XML</report>') }])
  expect(await parseDocument(ordinaryZip, {})).toMatchObject({
    format: 'zip',
    text: expect.stringContaining('word/document.xml'),
  })
  expect(await parseDocument(ordinaryZip, { entry: 'word/document.xml' })).toMatchObject({
    format: 'text',
    text: '<report>plain XML</report>',
  })
  const largeMember = zip([
    { name: 'program.exe', data: Buffer.from('x'), declaredSize: 256 * 1024 * 1024 },
    { name: 'README.txt', data: Buffer.from('read this without unpacking the program') },
  ])
  expect((await parseDocument(largeMember, {})).text).toContain('program.exe')
  expect((await parseDocument(largeMember, { entry: 'README.txt' })).text).toContain('read this')
  await expect(parseDocument(largeMember, { entry: 'program.exe' })).rejects.toMatchObject({
    code: 'DOCUMENT_SIZE_LIMIT',
  })
  expect(
    (
      await parseDocument(
        zip(
          Array.from({ length: 501 }, (_, index) => ({
            name: `file-${index}.txt`,
            data: Buffer.from('x'),
          })),
        ),
        {},
      )
    ).text,
  ).toContain('file-500.txt')
  await expect(
    parseDocument(zip([{ name: 'nested.zip', data: ordinaryZip }]), { entry: 'nested.zip' }),
  ).rejects.toMatchObject({ code: 'NESTED_ZIP_UNSUPPORTED' })
})

it.each(['../escape', '/escape', 'a/../escape', 'a\\escape', 'C:/escape', 'a\u0000b'])(
  'rejects unsafe ZIP names: %s',
  async (name) => {
    await expect(parseDocument(zip([{ name, data: Buffer.from('data') }]), {})).rejects.toThrow()
  },
)

it('rejects links, duplicates, corrupted checksums and nested archives', async () => {
  for (const entries of [
    [{ name: 'link', data: Buffer.from('target'), mode: 0xa000 }],
    [
      { name: 'a', data: Buffer.from('x') },
      { name: 'a', data: Buffer.from('y') },
    ],
  ])
    await expect(parseDocument(zip(entries), {})).rejects.toThrow()
  await expect(
    parseDocument(zip([{ name: 'a', data: Buffer.from('data'), checksum: 0 }]), { entry: 'a' }),
  ).rejects.toMatchObject({ code: 'ZIP_ENTRY_READ_FAILED' })
  await expect(
    parseDocument(zip([{ name: 'a.zip', data: zip([]) }]), { entry: 'a.zip' }),
  ).rejects.toMatchObject({ code: 'NESTED_ZIP_UNSUPPORTED' })
  await expect(
    parseDocument(zip([{ name: 'a', data: Buffer.alloc(10000), declaredSize: 1 }]), { entry: 'a' }),
  ).rejects.toThrow()
})

it('uses actual bytes for mislabeled CSV, handles BOM text and refuses unsupported binary', async () => {
  expect(
    (await parseDocument(Buffer.from('name,value\n中文,1'), { mimeType: 'application/vnd.ms-excel' })).text,
  ).toContain('中文,1')
  expect(
    (await parseDocument(Buffer.concat([Buffer.from([255, 254]), Buffer.from('中文', 'utf16le')]), {})).text,
  ).toBe('中文')
  await expect(parseDocument(Buffer.from([255, 0, 128]), {})).rejects.toMatchObject({
    code: 'DOCUMENT_FORMAT_UNSUPPORTED',
  })
})

it('paginates long Unicode rows without truncating their middle or exceeding the output budget', () => {
  const text = '中文😀'.repeat(2000)
  const result = { format: 'text', text, note: 'fixture' }
  let offset = 1,
    restored = ''
  for (;;) {
    const output = textPage(result, { offset, limit: 2 }, 4096)
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4096)
    restored += output
      .split('\n')
      .filter((row) => /^\d+\t/u.test(row))
      .map((row) => row.slice(row.indexOf('\t') + 1))
      .join('')
    const next = output.match(/offset=(\d+)/u)
    if (!next) break
    expect(Number(next[1])).toBeGreaterThan(offset)
    offset = Number(next[1])
  }
  expect(restored).toBe(text)
  expect(textPage({ ...result, text: '\n'.repeat(1000000) }, {}, 4096)).toContain('offset=101')
})
