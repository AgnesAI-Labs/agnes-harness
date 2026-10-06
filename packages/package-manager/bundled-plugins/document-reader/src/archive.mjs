import { crc32 } from 'node:zlib'
import yauzl from 'yauzl'
import { fail, LIMITS } from './limits.mjs'

/** Validate central metadata first. No archive path is ever opened on disk. */
export function openArchive(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, autoClose: false, strictFileNames: true },
      (error, zip) => {
        if (error) return reject(fail('INVALID_ZIP', 'The ZIP archive is damaged or unsupported.'))
        const entries = [],
          names = new Set()
        let settled = false
        const refuse = (error) => {
          if (settled) return
          settled = true
          zip.close()
          reject(error)
        }
        zip.on('error', () => refuse(fail('INVALID_ZIP', 'The ZIP archive could not be read.')))
        zip.on('entry', (entry) => {
          const name = entry.fileName,
            clean = name.endsWith('/') ? name.slice(0, -1) : name
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000
          if (
            !clean ||
            clean.length > 1024 ||
            // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes in archive labels.
            /[\u0000-\u001f\u007f\\:]/u.test(clean) ||
            clean.split('/').some((part) => !part || part === '.' || part === '..') ||
            names.has(name) ||
            ![0, 0x4000, 0x8000].includes(mode) ||
            entry.generalPurposeBitFlag & 1 ||
            ![0, 8].includes(entry.compressionMethod)
          )
            return refuse(
              fail(
                'UNSAFE_ZIP_ENTRY',
                'The ZIP contains an unsafe, duplicate, encrypted or unsupported entry.',
              ),
            )
          names.add(name)
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0)
            return refuse(fail('INVALID_ZIP', 'The ZIP entry has an invalid declared size.'))
          entries.push(entry)
          zip.readEntry()
        })
        zip.on('end', () => {
          if (settled) return
          settled = true
          resolve({ entries, close: () => zip.close(), read: (name) => readEntry(zip, entries, name) })
        })
        zip.readEntry()
      },
    )
  })
}

function readEntry(zip, entries, name) {
  const entry = entries.find((item) => item.fileName === name)
  if (!entry || entry.fileName.endsWith('/'))
    throw fail('ZIP_ENTRY_NOT_FOUND', 'Select a file using its exact name from the ZIP listing.')
  // Listing never inflates other members. Selected documents share the reader's input budget.
  if (entry.uncompressedSize > LIMITS.inputBytes)
    throw fail('DOCUMENT_SIZE_LIMIT', "The selected document exceeds the reader's 100 MiB input budget.")
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(fail('ZIP_ENTRY_READ_FAILED', 'The selected ZIP entry could not be read.'))
      const chunks = []
      let size = 0,
        checksum = 0
      stream.on('error', () => reject(fail('ZIP_ENTRY_READ_FAILED', 'The selected ZIP entry is damaged.')))
      stream.on('data', (chunk) => {
        size += chunk.length
        if (size > entry.uncompressedSize || size > LIMITS.inputBytes) {
          stream.destroy(
            fail(
              'ZIP_ENTRY_READ_FAILED',
              'Expanded entry exceeds its declared size or the reader input budget.',
            ),
          )
          return
        }
        chunks.push(chunk)
        checksum = crc32(chunk, checksum)
      })
      stream.on('end', () => {
        if (size !== entry.uncompressedSize)
          return reject(fail('ZIP_ENTRY_READ_FAILED', 'The ZIP entry length is invalid.'))
        if (checksum !== entry.crc32)
          return reject(fail('ZIP_ENTRY_READ_FAILED', 'The ZIP entry checksum is invalid.'))
        resolve(Buffer.concat(chunks, size))
      })
    })
  })
}
