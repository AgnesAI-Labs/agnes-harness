import { defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import { guardedResult } from '../../tools-core/src/guards/output.js'
import { formatTool } from './format.js'
import type { LspSessions } from './registry.js'

export function createLspDiagnosticsTool(lsp: LspSessions) {
  return defineTool({
    name: 'lsp_diagnostics',
    description:
      'Ask the language server for the current compile and type errors of source files (TypeScript/JavaScript, Python, Go, Rust), for example after changing a file another file depends on. write and edit already report errors of the file they changed; use this for other files. Needs the language server on PATH, for example typescript-language-server, pyright-langserver, gopls or rust-analyzer.',
    parameters: Type.Object(
      {
        paths: Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: 20,
          description: 'Files to check, relative to the workspace.',
        }),
        severity: Type.Optional(
          Type.Union([Type.Literal('error'), Type.Literal('warning'), Type.Literal('all')], {
            description: "What to list: 'error' (default), 'warning' (errors and warnings) or 'all'.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    meta: {
      // Read-only with no approval only because servers start in a no-workspace-code mode (see servers.ts).
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: {},
      deferLoading: 'auto',
      requiresApproval: 'never',
    },
    async execute(args, ctx) {
      const reports = await lsp.check(ctx, args.paths)
      return guardedResult(ctx, formatTool(reports, args.severity ?? 'error'))
    },
  })
}
