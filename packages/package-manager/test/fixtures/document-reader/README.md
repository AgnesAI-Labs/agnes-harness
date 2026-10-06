# Legacy DOC fixture

`legacy.doc` is the unmodified `__tests__/data/test01.doc` fixture from
[Word Extractor](https://github.com/morungos/node-word-extractor/blob/d971d9f69056245ae129bd2ce31436d518293854/__tests__/data/test01.doc),
revision `d971d9f69056245ae129bd2ce31436d518293854`.
It verifies legacy OLE Word text and Unicode extraction without Microsoft Office.

Copyright (c) 2016-2021 Stuart Watt. MIT; the upstream LICENSE is retained here.
PDF and DOCX fixtures are synthesized by the test helper and contain no user documents.

`chinese-scan.rgb.deflate` is a synthetic 600×800 RGB raster containing only
“中文文档测试”, on a white background, compressed with zlib. It tests Chinese OCR
and forced OCR on a mixed image/text page. No font software is embedded.
