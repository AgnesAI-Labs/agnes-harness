import type { MemoryParagraphList, MemoryParagraphPort } from '../src/memory.js'

/**
 * One fresh memory store for a paragraph-port check. The port must be able to commit without asking
 * (auto mode, or a test approval). `editStored` changes the stored file outside the port, as a
 * person editing it would. `ids` are three valid paragraph ids for this provider.
 */
export type MemoryParagraphFixture = Readonly<{
  port: MemoryParagraphPort
  editStored(): Promise<void>
  ids: readonly [string, string, string]
}>

class ParagraphConformanceError extends Error {
  constructor(testCase: string, detail: string) {
    super(`Memory paragraph conformance (${testCase}): ${detail}`)
  }
}

async function listed(port: MemoryParagraphPort, testCase: string): Promise<MemoryParagraphList> {
  const list = await port.list()
  if (!list || typeof list.hash !== 'string' || !list.hash || !Array.isArray(list.paragraphs))
    throw new ParagraphConformanceError(testCase, 'list() must return { hash, paragraphs }')
  return list
}

/** Paragraph texts by id, in id order, so the comparison does not depend on file order. */
function texts(list: MemoryParagraphList): Record<string, string> {
  return Object.fromEntries(
    list.paragraphs
      .map((paragraph) => [paragraph.id, paragraph.text] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  )
}

async function refused(operation: () => Promise<unknown>, testCase: string, code?: string): Promise<void> {
  try {
    await operation()
  } catch (error) {
    const actual = (error as { code?: unknown } | null)?.code
    if (code === undefined || actual === code) return
    throw new ParagraphConformanceError(testCase, `expected ${code}, got ${String(actual)}`)
  }
  throw new ParagraphConformanceError(testCase, `expected a refusal${code ? ` with ${code}` : ''}`)
}

function same(actual: unknown, expected: unknown, testCase: string, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new ParagraphConformanceError(
      testCase,
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
}

/**
 * Black-box checks of `MemorySession.paragraphs`: `list` names the file hash it read, one change
 * without a base still works, a batch lands in one commit, a stale base or a stale proposal is
 * refused with `MEMORY_CONFLICT` and writes nothing, and a batch with one bad member writes nothing.
 * Returns the names of the cases that passed; throws on the first failure.
 */
export async function memoryParagraphConformance(
  open: () => Promise<MemoryParagraphFixture>,
): Promise<readonly string[]> {
  const passed: string[] = []

  {
    const { port } = await open()
    await listed(port, 'list')
    passed.push('list')
  }

  {
    const testCase = 'single-change-without-base'
    const { port, ids } = await open()
    const before = await listed(port, testCase)
    const proposal = await port.propose({ op: 'put', id: ids[0], text: 'first note' })
    same(proposal.baseHash, before.hash, testCase, 'proposal base')
    const { hash } = await port.commit(proposal)
    const after = await listed(port, testCase)
    same(after.hash, hash, testCase, 'hash after commit')
    same(texts(after)[ids[0]], 'first note', testCase, 'stored paragraph')
    passed.push(testCase)
  }

  {
    const testCase = 'batch-in-one-commit'
    const { port, ids } = await open()
    await port.commit(await port.propose({ op: 'put', id: ids[2], text: 'old note' }))
    const before = await listed(port, testCase)
    const proposal = await port.propose(
      [
        { op: 'put', id: ids[0], text: 'merged note' },
        { op: 'put', id: ids[1], text: 'second note' },
        { op: 'remove', id: ids[2] },
      ],
      before.hash,
    )
    const { hash } = await port.commit(proposal)
    const after = await listed(port, testCase)
    same(after.hash, hash, testCase, 'hash after commit')
    const expected: Record<string, string> = {
      ...texts(before),
      [ids[0]]: 'merged note',
      [ids[1]]: 'second note',
    }
    delete expected[ids[2]]
    same(
      texts(after),
      texts({
        hash,
        paragraphs: Object.entries(expected).map(([id, text]) => ({ id, text, validity: 'valid' })),
      }),
      testCase,
      'stored paragraphs',
    )
    passed.push(testCase)
  }

  {
    const testCase = 'stale-base-refused'
    const { port, ids, editStored } = await open()
    const base = await listed(port, testCase)
    await editStored()
    const edited = await listed(port, testCase)
    if (edited.hash === base.hash) throw new ParagraphConformanceError(testCase, 'editStored changed nothing')
    await refused(
      () => port.propose({ op: 'put', id: ids[0], text: 'late note' }, base.hash),
      testCase,
      'MEMORY_CONFLICT',
    )
    same(await listed(port, testCase), edited, testCase, 'stored file after refusal')
    passed.push(testCase)
  }

  {
    const testCase = 'stale-commit-refused'
    const { port, ids, editStored } = await open()
    const proposal = await port.propose({ op: 'put', id: ids[0], text: 'late note' })
    await editStored()
    const edited = await listed(port, testCase)
    await refused(() => port.commit(proposal), testCase, 'MEMORY_CONFLICT')
    same(await listed(port, testCase), edited, testCase, 'stored file after refusal')
    passed.push(testCase)
  }

  {
    const testCase = 'all-or-nothing'
    const { port, ids } = await open()
    const before = await listed(port, testCase)
    await refused(
      () =>
        port.propose(
          [
            { op: 'put', id: ids[0], text: 'would be lost' },
            { op: 'remove', id: ids[1] },
          ],
          before.hash,
        ),
      testCase,
    )
    same(await listed(port, testCase), before, testCase, 'stored file after a refused batch')
    passed.push(testCase)
  }

  return passed
}
