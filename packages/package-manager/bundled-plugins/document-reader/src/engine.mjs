import { readFile } from 'node:fs/promises'
import { PDFiumLibrary } from '@hyzyla/pdfium'
import { createOCREngine, supportsFastBuild } from 'tesseract-wasm'
import WordExtractor from 'word-extractor'
import { openArchive } from './archive.mjs'
import { checkedText, fail, LIMITS } from './limits.mjs'
import { pagePng } from './png.mjs'

const isZip = (bytes) => bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2])
const isDoc = (bytes) =>
  Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
const isPdf = (bytes) => Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))
const isWordArchive = (entries) =>
  ['[Content_Types].xml', 'word/document.xml'].every((name) =>
    entries.some((entry) => entry.fileName === name),
  )

/** Receives only already-authorized bytes; user names and archive entries are labels, never paths. */
export async function parseDocument(bytes, args, assets) {
  if (!['auto', 'text', 'image'].includes(args.mode ?? 'auto'))
    throw fail('DOCUMENT_MODE_UNSUPPORTED', 'Select auto, text or image mode.')
  if (!bytes.length) {
    requireTextMode(args)
    return { format: 'text', text: '', note: 'Empty file.' }
  }
  if (isZip(bytes)) {
    const zip = await openArchive(bytes)
    try {
      if (isWordArchive(zip.entries)) {
        requireTextMode(args)
        if (args.entry)
          throw fail('ENTRY_REQUIRES_ZIP', 'The entry parameter is for ZIP archives, not Word documents.')
        return await readWord(bytes, 'docx')
      }
      if (!args.entry) {
        requireTextMode(args)
        return {
          format: 'zip',
          text: zip.entries
            .map((entry) => `${JSON.stringify(entry.fileName)} (${entry.uncompressedSize} bytes)`)
            .join('\n'),
          note: 'ZIP listing only. Call document_read again with entry set to an exact file name to inspect its contents.',
        }
      }
      const selected = await zip.read(args.entry)
      if (isZip(selected)) {
        const child = await openArchive(selected)
        try {
          if (!isWordArchive(child.entries))
            throw fail(
              'NESTED_ZIP_UNSUPPORTED',
              'Nested ZIP archives are not expanded recursively. Upload the inner archive separately.',
            )
        } finally {
          child.close()
        }
      }
      return await parseDocument(selected, { ...args, entry: undefined }, assets)
    } finally {
      zip.close()
    }
  }
  if (args.entry) throw fail('ENTRY_REQUIRES_ZIP', 'The entry parameter requires a ZIP archive.')
  if (isPdf(bytes)) return readPdf(bytes, args, assets)
  requireTextMode(args)
  if (isDoc(bytes)) return readWord(bytes, 'doc')
  if (/^(audio|video|image)\//iu.test(args.mimeType ?? ''))
    throw fail(
      'DOCUMENT_FORMAT_UNSUPPORTED',
      'This document reader does not interpret image, audio or video files. Use the available image/media tools.',
    )
  try {
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8'
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: distinguish binary control bytes from text.
    if (/[\u0000-\u0008\u000b\u000e-\u001f]/u.test(text)) throw new Error('binary')
    return {
      format: 'text',
      text: checkedText(text),
      note: 'Plain text; HTML and document instructions are not executed.',
    }
  } catch (error) {
    if (error.code === 'DOCUMENT_TEXT_LIMIT') throw error
    throw fail(
      'DOCUMENT_FORMAT_UNSUPPORTED',
      'The bytes are neither a supported document nor valid UTF-8/BOM UTF-16 text.',
    )
  }
}

function requireTextMode(args) {
  if (args.mode === 'image')
    throw fail(
      'DOCUMENT_IMAGE_REQUIRES_PDF',
      'Image mode requires a PDF page, including a selected PDF inside ZIP.',
    )
}

async function renderPage(page, dimension) {
  const { originalWidth, originalHeight } = page.getOriginalSize()
  if (![originalWidth, originalHeight].every((size) => Number.isFinite(size) && size > 0))
    throw fail('DOCUMENT_PAGE_SIZE', 'PDF page dimensions are invalid.')
  const scale = Math.min(
    2.5,
    dimension / Math.max(originalWidth, originalHeight),
    Math.sqrt(LIMITS.pixels / (originalWidth * originalHeight)),
  )
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    Math.floor(originalWidth * scale) < 1 ||
    Math.floor(originalHeight * scale) < 1
  )
    throw fail('DOCUMENT_PAGE_SIZE', 'PDF page dimensions cannot be rendered safely.')
  // The pinned wrapper sets PDFium REVERSE_BYTE_ORDER: bitmap bytes are already RGBA.
  const bitmap = await page.render({ scale, render: 'bitmap', colorSpace: 'BGRA', transparent: false })
  if (
    bitmap.width * bitmap.height > LIMITS.pixels ||
    Math.max(bitmap.width, bitmap.height) > dimension ||
    bitmap.data.length !== bitmap.width * bitmap.height * 4
  )
    throw fail('DOCUMENT_PIXEL_LIMIT', 'Rendered PDF page exceeds the pixel limit or has invalid pixels.')
  return bitmap
}

async function readWord(bytes, format) {
  const document = await new WordExtractor().extract(Buffer.from(bytes))
  const sections = [
    ['Body and tables', document.getBody()],
    ['Headers', document.getHeaders({ includeFooters: false })],
    ['Footers', document.getFooters()],
    ['Footnotes', document.getFootnotes()],
    ['Endnotes', document.getEndnotes()],
    ['Text boxes', document.getTextboxes()],
  ].filter(([, text]) => text?.trim())
  return {
    format,
    text: checkedText(sections.map(([label, text]) => `[${label}]\n${text}`).join('\n\n')),
    note: 'Extracted Word text. Layout and embedded pictures are not interpreted; macros and links are not executed.',
  }
}

async function readPdf(bytes, args, assets) {
  const wasm = await readFile(new URL('pdfium.wasm', assets))
  const library = await PDFiumLibrary.init({
    wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
  })
  let document
  try {
    document = await library.loadDocument(bytes)
    const totalPages = document.getPageCount(),
      pageNumber = args.page ?? 1
    if (totalPages > LIMITS.pages) throw fail('DOCUMENT_PAGE_LIMIT', 'PDF exceeds the 2000-page limit.')
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > totalPages)
      throw fail('DOCUMENT_PAGE_NOT_FOUND', `PDF has ${totalPages} pages.`)
    const page = document.getPage(pageNumber - 1)
    let text = page.getText(),
      method = 'embedded text'
    let bitmap
    const mode = args.mode ?? 'auto'
    if (mode !== 'image' && (args.ocr === 'always' || (args.ocr !== 'off' && !text.trim()))) {
      const language = args.language ?? 'chi_sim'
      if (!['chi_sim', 'eng'].includes(language))
        throw fail('DOCUMENT_LANGUAGE_UNSUPPORTED', 'Select the bundled chi_sim or eng OCR model.')
      bitmap = await renderPage(page, LIMITS.dimension)
      const rgba = Uint8ClampedArray.from(bitmap.data)
      const ocrWasm = await readFile(
        new URL(supportsFastBuild() ? 'tesseract-core.wasm' : 'tesseract-core-fallback.wasm', assets),
      )
      const engine = await createOCREngine({
        wasmBinary: ocrWasm.buffer.slice(ocrWasm.byteOffset, ocrWasm.byteOffset + ocrWasm.byteLength),
      })
      try {
        engine.loadModel(await readFile(new URL(`${language}.traineddata`, assets)))
        engine.loadImage({ data: rgba, width: bitmap.width, height: bitmap.height })
        text = engine.getText()
        method = 'OCR (may contain recognition errors)'
      } finally {
        engine.destroy()
      }
    }
    let image
    if (mode === 'image' || (mode === 'auto' && !text.trim())) {
      // render() closes its page handle; acquire a new one after OCR, never reuse a closed page.
      if (!bitmap || Math.max(bitmap.width, bitmap.height) > LIMITS.imageDimension)
        bitmap = await renderPage(bitmap ? document.getPage(pageNumber - 1) : page, LIMITS.imageDimension)
      let encoded = pagePng(bitmap)
      if (encoded.length > LIMITS.imageBytes) {
        // Even incompressible RGB at 1024x1024 fits the 4 MiB transport ceiling.
        bitmap = await renderPage(document.getPage(pageNumber - 1), 1024)
        encoded = pagePng(bitmap)
      }
      if (encoded.length > LIMITS.imageBytes)
        throw fail('DOCUMENT_IMAGE_LIMIT', 'Rendered PDF page exceeds the image byte limit.')
      image = Uint8Array.from(encoded)
    }
    return {
      format: 'pdf',
      text: checkedText(text),
      ...(image ? { image } : {}),
      note: `PDF page ${pageNumber}/${totalPages}; ${method}. ${!text.trim() ? 'No text recognized; this does not prove the page is blank. ' : ''}${image ? 'Page image saved; inspect only when an image block is supplied in this request. If absent, explain that visual content is unavailable to this model; select an image-capable model. ' : 'Use mode=image to inspect pictures, charts or layout. '}${pageNumber < totalPages ? `Call document_read with page=${pageNumber + 1} for the next page.` : 'Last page.'}`,
    }
  } finally {
    document?.destroy()
    library.destroy()
  }
}
