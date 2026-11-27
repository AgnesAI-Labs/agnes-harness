import type { BuildResult } from 'esbuild'
export function buildPdfPreview(webOutput: string): Promise<BuildResult>
export function copyPdfPreviewNotice(webOutput: string): Promise<void>
