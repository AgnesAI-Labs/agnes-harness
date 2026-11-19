import type { LocaleCatalog } from './index.js'

/** Shared document preview labels for inline and rightbar consumers. */
export const documentPreviewLocaleCatalog: LocaleCatalog = {
  en: {
    'doc.preview.unavailable': '{kind} resource {reason}',
    'doc.reason.unauthorized': 'not authorized',
    'doc.reason.unavailable': 'unavailable',
    'doc.kind.image': 'Image',
    'doc.kind.pdf': 'PDF',
    'doc.imageFallback': 'Document image',
    'doc.pdfFallback': 'PDF document',
    'doc.pdfPrevious': 'Previous page',
    'doc.pdfNext': 'Next page',
    'doc.pdfFailed': 'PDF preview failed. Download the original file from the card to view it.',
  },
  'zh-CN': {
    'doc.preview.unavailable': '{kind}资源{reason}',
    'doc.reason.unauthorized': '未获授权',
    'doc.reason.unavailable': '不可用',
    'doc.kind.image': '图片',
    'doc.kind.pdf': 'PDF ',
    'doc.imageFallback': '文档图片',
    'doc.pdfFallback': 'PDF 文档',
    'doc.pdfPrevious': '上一页',
    'doc.pdfNext': '下一页',
    'doc.pdfFailed': 'PDF 预览失败，请在文件卡片下载原件查看。',
  },
}
