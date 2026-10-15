import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BatchEngine,
  compileSchema,
  csvCell,
  inertText,
  itemSummary,
  publishExport,
  Repository,
  renderExport,
  snapshotFolder,
} from '../src/index.js'
import { FakeExecutor, id, inputs, reference, spec, testStore } from './fakes.js'

const roots: string[] = []
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-batch-unit-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('input snapshots and bounded data exports', () => {
  it('snapshots sorted immutable inputs, retains unsupported rows and excludes hidden files, and refuses file or ancestor symlinks', async () => {
    // Canonicalize macOS /var -> /private/var before testing workspace containment.
    const { realpath } = await import('node:fs/promises')
    const root = await realpath(await temp())
    await mkdir(join(root, 'items'))
    await writeFile(join(root, 'items/b.txt'), 'beta')
    await writeFile(join(root, 'items/a.txt'), 'alpha')
    await writeFile(join(root, 'items/.secret'), 'hidden')
    await writeFile(join(root, 'items/book.xlsx'), 'unsupported')
    await writeFile(join(root, 'items/big.txt'), Buffer.alloc(1024 * 1024 + 1))
    await mkdir(join(root, 'items/agh-batch'))
    await writeFile(join(root, 'items/agh-batch/results.jsonl'), 'previous results')
    const blobs = new Map<string, Uint8Array>()
    const artifacts = {
      put: async (bytes: Uint8Array, meta: { digest: string }) => {
        blobs.set(meta.digest, bytes.slice())
        return reference(meta.digest, bytes.length)
      },
    }
    const files = await snapshotFolder({ id, root, dir: 'items', artifacts })
    expect(files.map((f) => f.name)).toEqual(['a.txt', 'b.txt', 'big.txt', 'book.xlsx'])
    expect(files[2]).toMatchObject({ skip: 'too_large' })
    expect(files[3]).toMatchObject({ skip: 'unsupported_type' })
    const engine = new BatchEngine(new Repository(testStore()), new FakeExecutor())
    await engine.begin(id, spec, files)
    expect(await engine.tick(id)).toMatchObject({ status: 'completed', successes: 2, skipped: 2 })
    expect((await renderExport(engine.repo, id)).files['errors.jsonl']).toContain('unsupported_type')
    await writeFile(join(root, 'items/a.txt'), 'changed')
    expect(Buffer.from(blobs.get(files[0]!.digest)!).toString()).toBe('alpha')
    await symlink(join(root, 'items/a.txt'), join(root, 'items/link.txt'))
    await expect(snapshotFolder({ id, root, dir: 'items', artifacts })).rejects.toMatchObject({
      code: 'E_BATCH_SYMLINK',
    })
    await symlink(join(root, 'items'), join(root, 'alias'))
    await expect(snapshotFolder({ id, root, dir: 'alias', artifacts })).rejects.toMatchObject({
      code: 'E_BATCH_SYMLINK',
    })
    await expect(snapshotFolder({ id, root, dir: '../outside', artifacts })).rejects.toMatchObject({
      code: 'E_BATCH_PATH',
    })
  })
  it('refuses count/byte ceilings and changes observed during capture', async () => {
    const { realpath } = await import('node:fs/promises')
    const root = await realpath(await temp())
    await mkdir(join(root, 'items'))
    await writeFile(join(root, 'items/a.txt'), 'a')
    await writeFile(join(root, 'items/b.txt'), 'b')
    const artifacts = {
      put: async (bytes: Uint8Array, meta: { digest: string }) => reference(meta.digest, bytes.length),
    }
    await expect(snapshotFolder({ id, root, dir: 'items', artifacts, maxFiles: 1 })).rejects.toMatchObject({
      code: 'E_BATCH_INPUT_LIMIT',
    })
    await expect(
      snapshotFolder({ id, root, dir: 'items', artifacts, maxTotalBytes: 1 }),
    ).rejects.toMatchObject({
      code: 'E_BATCH_INPUT_LIMIT',
    })
    await expect(
      snapshotFolder({
        id,
        root,
        dir: 'items',
        artifacts: {
          put: async (bytes: Uint8Array, meta: { digest: string }) => {
            await writeFile(join(root, 'items/new.txt'), 'new')
            return reference(meta.digest, bytes.length)
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'E_BATCH_CHANGED' })
  })
  it.each([
    { type: 'object', properties: { x: { type: 'string', pattern: '(a+)+$' } } },
    { type: 'object', properties: { x: { type: 'array', items: { type: 'number' }, uniqueItems: true } } },
    { type: 'object', $ref: 'https://invalid/schema' },
    { type: 'object', $async: true },
    { type: 'object', properties: { x: { type: 'number', minimum: -Infinity } } },
  ])('rejects costly or invalid output schema %j', (schema) => {
    expect(() => compileSchema(schema)).toThrow()
  })
  it('treats keyword-like property names as data, checks own properties, and limits output validation work', () => {
    const check = compileSchema({
      type: 'object',
      properties: { pattern: { type: 'integer' } },
      required: ['pattern'],
      additionalProperties: false,
    })
    expect(check({ pattern: 2 })).toBe(true)
    expect(check({ pattern: '2' })).toBe(false)
    const own = compileSchema({ type: 'object', required: ['constructor'] })
    expect(own({})).toBe(false)
    const duplicates = compileSchema({
      type: 'object',
      properties: {
        rows: { type: 'array', items: { type: 'string' }, uniqueItems: false },
      },
    })
    expect(duplicates({ rows: ['a', 'a'] })).toBe(true)
    expect(duplicates({ rows: [1] })).toBe(false)
  })
  it('exports inert CSV/Markdown and JSON data with byte ceilings; rejects concurrent publication and existing targets', async () => {
    const { realpath } = await import('node:fs/promises')
    const root = await realpath(await temp()),
      repo = new Repository(testStore()),
      executor = new FakeExecutor()
    executor.reply = () => ({
      state: 'completed',
      charged: 0.1,
      inputRead: true,
      text: '=HYPERLINK("evil")\u001b[31m **[click](evil)**',
    })
    const engine = new BatchEngine(repo, executor)
    await engine.begin(id, spec, [{ ...inputs[0]!, name: '=formula.txt' }])
    await engine.tick(id)
    const bundle = await renderExport(repo, id)
    expect(bundle.files['results.csv']).toContain("'=formula.txt")
    expect(bundle.files['results.csv']).not.toContain('\u001b')
    expect(JSON.parse(bundle.files['results.jsonl']!.trim()).output.text).toContain('HYPERLINK')
    const item = (await repo.page(id))[0]!
    expect(
      itemSummary({ ...item, input: { ...item.input, name: '[click](evil)|<script>\u001b' } }),
    ).not.toContain('<script>')
    expect(inertText('\u001b[31m\u202eevil')).not.toContain('\u202e')
    for (const cell of ['=1', '+2', '-3', '@SUM(A1)', '\t=1', ' \r+1']) expect(csvCell(cell)).toMatch(/^"'/u)
    await expect(renderExport(repo, id, 10)).rejects.toMatchObject({ code: 'E_BATCH_EXPORT_LIMIT' })
    const outcomes = await Promise.allSettled([
      publishExport(root, 'out', bundle),
      publishExport(root, 'out', bundle),
    ])
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await readFile(join(root, 'out/results.jsonl'), 'utf8')).toBe(bundle.files['results.jsonl'])
    await expect(publishExport(root, 'out', bundle)).rejects.toMatchObject({ code: 'E_BATCH_EXPORT_EXISTS' })
    await expect(publishExport(root, '../escape', bundle)).rejects.toMatchObject({
      code: 'E_BATCH_EXPORT_PATH',
    })
    await symlink(root, join(root, 'alias'))
    await expect(publishExport(root, 'alias/nested', bundle)).rejects.toMatchObject({
      code: 'E_BATCH_EXPORT_PATH',
    })
  })
  it('does not export unsettled or unknown state', async () => {
    const repo = new Repository(testStore())
    await repo.begin(id, spec, inputs, 1)
    await expect(renderExport(repo, id)).rejects.toMatchObject({ code: 'E_BATCH_NOT_TERMINAL' })
  })
})
