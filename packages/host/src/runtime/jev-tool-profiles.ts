import type { DecisionToolProfile, ToolDescriptor } from '@agnes/jev-runtime'

// AGH bundled-tool profiles: purpose is independent of a tool's effect class.
// This table is used only after the Host companion verifies the bundled registration.
const guidance: Record<string, Omit<DecisionToolProfile, 'operation' | 'toolRevision'>> = {
  read: {
    selection:
      'Read known file contents, local PNG/JPEG evidence, or stored artifact output; continue text pages.',
    phases: ['INSPECT', 'VERIFY'],
    inputs: 'path; text-only optional 1-based line offset and line limit',
    result: 'Text lines and page coverage, or immutable image artifact evidence.',
    constraints: [
      'Images reject offset and limit; omit them when file type is unknown. GIF/WebP are unsupported.',
      'Use artifact:// from truncated output to read stored text; a page is not the whole file.',
      'Text alone does not establish that code ran or content rendered.',
    ],
  },
  find: {
    selection:
      'Discover recursive file paths by glob; use grep for contents and ls for direct directory entries.',
    phases: ['INSPECT', 'VERIFY'],
    inputs: 'glob pattern (** spans directories); optional search-root path and limit',
    result: 'Matching paths and coverage.',
    constraints: [
      'A match does not establish contents or MIME type; build/dependency and denied paths are skipped.',
    ],
  },
  grep: {
    selection: 'Search contents by regular expression or literal text, including stored artifact output.',
    phases: ['INSPECT', 'VERIFY'],
    inputs:
      'regular-expression pattern (literal=true for plain text); optional path, glob and search controls',
    result: 'Matching lines, paths and coverage.',
    constraints: ['Search results may omit unmatched context; use read when surrounding context is needed.'],
  },
  ls: {
    selection: 'Inspect the direct entries of a directory.',
    phases: ['INSPECT', 'VERIFY'],
    inputs: 'optional path and limit',
    result: 'Direct entries marked as files, directories, symbolic links or other kinds, with coverage.',
    constraints: ['A directory entry does not establish file contents or complete subtree coverage.'],
  },
  write: {
    selection: 'Create a file or replace its complete contents; use edit for targeted changes.',
    phases: ['ACT'],
    inputs: 'path and complete content',
    result: 'Acknowledged path and submitted UTF-8 byte digest.',
    constraints: [
      'Read an existing file before replacing it; prefer edit for targeted changes.',
      'An acknowledged write is not independent readback or evidence that the task is correct.',
    ],
  },
  edit: {
    selection: 'Apply ordered exact text replacements to one existing UTF-8 file, preserving other contents.',
    phases: ['ACT'],
    inputs: 'path and exact text edits',
    result: 'Acknowledged path and submitted UTF-8 byte digest.',
    constraints: [
      'Read the file first unless this session just created or edited it.',
      'Each oldText must match exactly once after preceding replacements; all edits validate before writing.',
      'Read back to verify the resulting contents.',
    ],
  },
}

export function bundledToolProfile(tool: ToolDescriptor): DecisionToolProfile | undefined {
  const profile = guidance[tool.name]
  return profile && { ...profile, operation: tool.name, toolRevision: tool.revision }
}
