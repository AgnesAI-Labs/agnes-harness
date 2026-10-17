import { TOOL_PATH_REFERENCES, type ToolResult } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { lsTool } from '../src/tools/ls.js'
import { pathReferences } from '../src/tools/references.js'

const ctxOf = (o: Parameters<typeof fakeToolContext>[0] = {}) =>
  fakeToolContext({ outputMaxBytes: 8192, ...o })
const textOf = (r: ToolResult) => (r.content[0]?.type === 'text' ? r.content[0].text : '')

describe('pathReferences', () => {
  it('lists shown paths inside the workspace and counts the rest', () => {
    const ctx = ctxOf()
    const refs = pathReferences(
      ctx,
      [
        { abs: '/work/proj/src', kind: 'directory' },
        { abs: '/elsewhere/x', kind: 'file' },
        { abs: `/work/proj/${'a'.repeat(1100)}`, kind: 'file' },
        { abs: '/work/proj/b.ts', kind: 'file' },
      ],
      3,
      false,
    )
    expect(refs).toEqual({
      schema: TOOL_PATH_REFERENCES,
      references: [{ kind: 'directory', path: 'src' }],
      total: 4,
      truncated: true,
    })
  })
  it('stops at 100 references', () => {
    const found = Array.from({ length: 150 }, (_, i) => ({ abs: `/work/proj/f${i}`, kind: 'file' as const }))
    const refs = pathReferences(ctxOf(), found, 150, false)
    expect(refs.references).toHaveLength(100)
    expect(refs).toMatchObject({ total: 150, truncated: true })
  })
})

describe('ls references', () => {
  it('lists the shown entries with their kinds and keeps the text as it was', async () => {
    const ctx = ctxOf({
      files: { 'src/a.ts': '', 'top.txt': '' },
      entries: {
        '/work/proj': [
          { name: 'link', kind: 'symlink' },
          { name: 'pipe', kind: 'other' },
        ],
      },
    })
    const r = await lsTool.execute({ path: '/work/proj' }, ctx)
    expect(textOf(r).split('\n')).toEqual(['link@', 'pipe?', 'src/', 'top.txt'])
    expect(r.structured).toEqual({
      schema: TOOL_PATH_REFERENCES,
      references: [
        { kind: 'symlink', path: 'link' },
        { kind: 'other', path: 'pipe' },
        { kind: 'directory', path: 'src' },
        { kind: 'file', path: 'top.txt' },
      ],
      total: 4,
      truncated: false,
    })
  })
  it('lists only the entries the limit shows', async () => {
    const ctx = ctxOf({ files: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, ''])) })
    const r = await lsTool.execute({ limit: 2 }, ctx)
    expect(textOf(r).split('\n')).toEqual(['f0.txt', 'f1.txt', '[3 more]'])
    expect(r.structured).toMatchObject({
      references: [
        { kind: 'file', path: 'f0.txt' },
        { kind: 'file', path: 'f1.txt' },
      ],
      total: 5,
      truncated: true,
    })
  })
  it('lists paths of a subdirectory relative to the workspace', async () => {
    const r = await lsTool.execute({ path: 'src' }, ctxOf({ files: { 'src/a.ts': '' } }))
    expect(r.structured).toMatchObject({ references: [{ kind: 'file', path: 'src/a.ts' }] })
  })
  it('lists nothing outside the workspace but counts it', async () => {
    const ctx = ctxOf({ files: { '/outside/x.txt': '' } })
    const r = await lsTool.execute(
      { path: '/outside' },
      { ...ctx, session: { ...ctx.session, fullAccess: true } },
    )
    expect(textOf(r)).toBe('x.txt')
    expect(r.structured).toEqual({ schema: TOOL_PATH_REFERENCES, references: [], total: 1, truncated: true })
  })
  it('gives an empty directory empty references and a failure none', async () => {
    const empty = await lsTool.execute({ path: 'nothing-here' }, ctxOf({ files: { 'a/keep.txt': '' } }))
    expect(empty.structured).toMatchObject({ references: [], total: 0, truncated: false })
    const failed = await lsTool.execute(
      { path: 'locked' },
      ctxOf({ files: { 'a.txt': '' }, listErrors: { locked: { code: 'EACCES', message: 'EACCES' } } }),
    )
    expect(failed.isError).toBe(true)
    expect(failed.structured).toBeUndefined()
  })
})
