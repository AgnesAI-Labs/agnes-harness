# Supplemental binary and omitted-package notices

These notices supplement the licenses collected from the JavaScript bundle graph.
They are copied into the ordinary plugin's generated `runtime/THIRD-PARTY-NOTICES`;
building and reading documents do not download notices or document data.

- `saxes.txt`: unmodified [ISC license from saxes v5.0.1](https://github.com/lddubeau/saxes/blob/v5.0.1/LICENSE).
  The pinned npm archive omits this file; the upstream license includes the inherited sax notice.
- `tesseract.txt`: [Tesseract 5.3.0 license](https://github.com/tesseract-ocr/tesseract/blob/080da83cc51c4ef8b324a7e03146fe0bd7e0944b/LICENSE).
- `leptonica.txt`: [Leptonica 1.83.1 license](https://github.com/DanBloomberg/leptonica/blob/b667978e86c4bf74f7fdd75f833127d2de327550/leptonica-license.txt).
  These versions are pinned in [tesseract-wasm 0.11.0's build inputs](https://github.com/robertknight/tesseract-wasm/blob/9aab28490d27a424019187e8169a62a64a50a028/third_party_versions.mk).
- `pdfium-third-party.txt`: concatenated, unmodified license texts with source URLs.
  The pinned [PDFium wrapper revision](https://github.com/hyzyla/pdfium/tree/274cac6e238b780eb4cafc989d7a5a70ffc5772b)
  uses pdfium-lib release 7243, based on PDFium `chromium/7243`. Notices include PDFium's own
  BSD/Apache terms, in-tree third-party notices, and dependency licenses at the revisions
  recorded in that branch's DEPS: FreeType, libjpeg-turbo, libpng, zlib, fast_float, and
  PartitionAlloc. These supplements do not change the respective license terms.

The generated payload also preserves wrapper licenses, JavaScript transitive dependency
licenses, data-package READMEs, and the Apache-2.0 license for upstream traineddata.
