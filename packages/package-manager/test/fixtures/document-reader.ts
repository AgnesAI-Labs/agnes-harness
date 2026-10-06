import { crc32, deflateRawSync, deflateSync } from 'node:zlib'

export function zip(
  entries: { name: string; data: Uint8Array; declaredSize?: number; checksum?: number; mode?: number }[],
): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = deflateRawSync(entry.data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(8, 8)
    header.writeUInt32LE(entry.checksum ?? crc32(entry.data), 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(entry.declaredSize ?? entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, data)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50)
    directory.writeUInt16LE(0x314, 4)
    directory.writeUInt16LE(20, 6)
    header.copy(directory, 8, 6, 28)
    directory.writeUInt32LE(((entry.mode ?? 0x8000) << 16) >>> 0, 38)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, name)
    offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

export function docx(): Buffer {
  return zip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>你好 DOCUMENT</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
      ),
    },
  ])
}

/** Minimal synthetic PDFs: text pages and optional RGB image-only pages, without third-party fixtures. */
export function pdf(
  pages: { text?: string; image?: { width: number; height: number; rgb: Uint8Array } }[],
): Buffer {
  const objects: Buffer[] = []
  const add = (value: string | Buffer) => {
    objects.push(typeof value === 'string' ? Buffer.from(value) : value)
    return objects.length
  }
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const ids: number[] = []
  for (const page of pages) {
    let image: number | undefined
    let instructions = page.text
      ? `BT /F1 32 Tf 30 700 Td (${page.text.replace(/[\\()]/gu, '\\$&')}) Tj ET\n`
      : ''
    if (page.image) {
      const packed = deflateSync(page.image.rgb)
      image = add(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${page.image.width} /Height ${page.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
          ),
          packed,
          Buffer.from('\nendstream'),
        ]),
      )
      instructions += 'q 600 0 0 800 0 0 cm /I1 Do Q\n'
    }
    const stream = add(`<< /Length ${Buffer.byteLength(instructions)} >>\nstream\n${instructions}endstream`)
    ids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 ${font} 0 R >> ${image ? `/XObject << /I1 ${image} 0 R >>` : ''} >> /Contents ${stream} 0 R >>`,
      ),
    )
  }
  objects[1] = Buffer.from(
    `<< /Type /Pages /Count ${ids.length} /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] >>`,
  )
  const output: Buffer[] = [Buffer.from('%PDF-1.7\n')],
    offsets = [0]
  let size = output[0]?.length ?? 0
  for (const [index, object] of objects.entries()) {
    offsets.push(size)
    const item = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
    output.push(item)
    size += item.length
  }
  output.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)
        .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
    ),
  )
  return Buffer.concat(output)
}
