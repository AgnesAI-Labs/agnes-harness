# Document Reader

An ordinary bundled Agnes Harness plugin, enabled by default and removable in Plugin management.
It registers `document_read`; disabling it removes document parsing without changing uploads or Core.

The tool reads only `session-file://<message>/<index>` attachments available through the current
session and lane. It never opens a user-supplied disk path, downloads a URL, runs macros, extracts
archive entries onto disk, or follows document instructions. Attachment bytes and extracted text
remain untrusted tool data under the existing Core boundary.

## Formats

- PDF: one selected page, using embedded text when present. `mode: "auto"` (default) extracts
  text/OCR and returns a page image when no text is recognized. `mode: "image"` returns the page
  image without OCR, for photographs, charts, layout, and mixed pages; embedded text is still
  included. `mode: "text"` never returns images. Empty extracted text does not mean a blank page.
- Scanned PDF: offline OCR with a bundled Chinese/English model (`chi_sim`, the default) or English
  model (`eng`). `ocr: "always"` renders a page even when it has an incomplete embedded text layer;
  `ocr: "off"` disables OCR. Mixed PDFs are handled page by page. Recognition errors are possible;
  OCR extracts letters, not picture meaning. Viewing page images uses the existing model image
  channel, respecting the selected model's image capability and limits, including history.
  A text-only model can still read extracted text; without a configured vision route it cannot
  interpret photographs. The tool explicitly warns against describing images that were not supplied.
- DOC and DOCX: body, tables, headers, footers, notes, and text boxes as plain text. Layout and
  embedded pictures are not reconstructed. Encrypted or damaged documents may fail explicitly.
- ZIP: list names first, then pass an exact `entry` to read a selected document or text file.
  Generic nested archives, encrypted entries, unsafe names, links, and unsupported compression
  methods are rejected. ZIP entries never become filesystem paths.
- UTF-8 and BOM-marked UTF-16 text: readable as a convenience; the existing `read` tool remains
  suitable for plain text, Markdown, HTML, CSV, and TSV.

Use `page` for PDF pages, and `offset`/`limit` for wrapped text rows. Follow continuation hints
with the same path, entry, page, mode, OCR, and language options. Standalone images, spreadsheets,
presentations, audio, and video are not interpreted by this document reader. Uploading and saving them remains
separate from whether a model or an installed plugin can understand their contents.

## Bounds and lifecycle

Input is limited to 100 MiB. ZIP names and metadata are checked before inflation; there is no
ZIP-specific entry-count or aggregate expanded-size cap. Only the selected entry is inflated,
never the whole archive. Selected documents share the reader's 100 MiB input budget and are
size/checksum checked; an oversized unused member does not prevent listing or reading other files.
Extracted text is capped at 8 MiB; returned text pages fit the tool output budget. PDFs may have
up to 2000 pages; OCR renders only the selected page, within 8 million pixels and 4096 pixels
per dimension.

PDF page images are opaque PNGs capped at 1456 pixels per dimension and 4 MiB; unusually noisy
pages are rendered again at a smaller size to fit. Only the selected page is returned, as a
session-authorized artifact, rather than storing base64 pixels in tool-result ledger rows.

Two workers may run at once; a job times out after 90 seconds. Cancellation and plugin disposal
terminate workers before releasing their slots. The JS worker heap is bounded;
this does not constitute an operating-system sandbox or a hard limit on all WASM allocations.

## Delivery and compatibility

The release build and `pnpm dev` prepare `src/runtime/` with bundled JS, WASM, local language
models, and third-party notices. Generated payloads are ignored in source control and included
in the ordinary plugin snapshot and integrity checks. Release users need no Office, LibreOffice,
Python, native Node addon, network OCR service, or separate plugin install. The same Node 24.10+
worker code and platform-independent WASM payloads run on Windows and macOS; both SIMD and
fallback OCR binaries ship. Source-only manual launches must prepare the payload through the
normal development entry point first.

Installed plugins use pinned snapshots. Rebuilding or restarting the application does not replace
an existing plugin snapshot. Update the installed `@agnes/document-reader` through Plugin management
from `file:./bundled-plugins/document-reader` after rebuilding; version 0.1.2 includes PDF page images
and the expanded attachment/ZIP budgets.
The ordinary update flow retains user control over plugin activation.

## Upstream components

- [PDFium wrapper](https://github.com/hyzyla/pdfium), `@hyzyla/pdfium` 2.1.13, MIT.
- [Word Extractor](https://github.com/morungos/node-word-extractor), 1.0.4, MIT.
- [Tesseract WASM](https://github.com/robertknight/tesseract-wasm), 0.11.0, BSD-2-Clause.
- [Tesseract trained data](https://github.com/tesseract-ocr/tessdata), Apache-2.0;
  pinned npm data packages `@tesseract.js-data/chi_sim` and `@tesseract.js-data/eng` 1.0.0
  declare MIT packaging metadata. Upstream model attribution and licenses ship in the payload.
- [yauzl](https://github.com/thejoshwolfe/yauzl), 3.4.0, MIT, with generated notices for its
  transitive dependencies.

The plugin's own code is Apache-2.0. Parser errors, OCR uncertainty, and unsupported formats
must be reported honestly; successful upload alone does not imply successful reading.
