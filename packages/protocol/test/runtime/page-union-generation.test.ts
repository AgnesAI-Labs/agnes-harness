import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type { JsonSchemaDoc } from '../../tools/gen-core.js'
import { generateRuntimeWireModules } from '../../tools/gen-runtime-full.js'

it('preserves readonly Page items through discriminated unions and mutable enclosing arrays', () => {
  const ref = (name: string) => ({ $ref: `#/$defs/${name}` })
  const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  })
  const document: JsonSchemaDoc = {
    $defs: {
      Item: object({ label: { type: 'string' } }),
      PageItem: object({ items: { type: 'array', items: ref('Item') }, complete: { type: 'boolean' } }),
      NamedPages: object({ pages: { type: 'array', items: ref('PageItem') } }),
      Nullable: object({
        page: { anyOf: [ref('PageItem'), { type: 'null' }] },
        pages: { anyOf: [{ type: 'array', items: ref('PageItem') }, { type: 'null' }] },
      }),
      Choice: {
        anyOf: [
          object({ kind: { const: 'page' }, topic: { const: 'items' }, page: ref('PageItem') }),
          object({ kind: { const: 'label' }, label: { type: 'string' } }),
          ref('NamedPages'),
          { type: 'null' },
        ],
      },
      Frame: object({ values: { type: 'array', items: ref('Choice') }, optional: ref('Choice') }, ['values']),
    },
  }
  const temporary = mkdtempSync(join(tmpdir(), 'runtime-page-union-'))
  try {
    symlinkSync(resolve('packages/protocol/node_modules'), join(temporary, 'node_modules'), 'dir')
    writeFileSync(join(temporary, 'package.json'), '{"type":"module"}')
    for (const [path, source] of Object.entries(
      generateRuntimeWireModules(document, {
        base: 'PageItem',
        instances: { PageItem: 'Item' },
      }),
    )) {
      const file = join(temporary, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, source)
    }
    const consumer = join(temporary, 'consumer.ts')
    writeFileSync(
      consumer,
      `import type { Choice, Frame, Nullable, PageItem } from './gen/ts/runtime-public.js'
export const nullable: Nullable = { page: null, pages: null }
export function preserveNullable(value: Nullable, page: PageItem) {
  value.page = null
  value.pages = null
  value.pages = [page]
  value.pages.push(page)
  // @ts-expect-error A Page inside a nullable array still has readonly items.
  value.pages[0]!.items.push({ label: 'invalid' })
}
export function consume(frame: Frame, choice: Choice, page: PageItem) {
  frame.values.push(choice)
  page.items = [{ label: 'replacement' }]
  if (choice && 'kind' in choice && choice.kind === 'page') {
    const item = choice.page.items[0]
    if (item) item.label = 'mutable DTO'
    // @ts-expect-error Page items remain readonly inside a union branch.
    choice.page.items.push({ label: 'invalid' })
  }
  if (choice && 'pages' in choice) {
    choice.pages.push(page)
    // @ts-expect-error Nested Page indices remain readonly.
    choice.pages[0]!.items[0] = { label: 'invalid' }
  }
  if (frame.optional && 'kind' in frame.optional && frame.optional.kind === 'page') {
    // @ts-expect-error Optional union branches also retain readonly items.
    frame.optional.page.items.push({ label: 'invalid' })
  }
}
`,
    )
    const result = spawnSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '--ignoreConfig',
        '--target',
        'ES2023',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--strict',
        '--exactOptionalPropertyTypes',
        '--noUncheckedIndexedAccess',
        '--noEmit',
        '--skipLibCheck',
        consumer,
      ],
      { cwd: temporary, encoding: 'utf8', timeout: 30_000 },
    )
    expect(result.error).toBeUndefined()
    expect(result.stdout + result.stderr).toBe('')
    expect(result.status).toBe(0)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
