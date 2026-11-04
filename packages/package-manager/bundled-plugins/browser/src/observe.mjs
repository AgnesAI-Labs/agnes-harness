import { randomUUID } from 'node:crypto'
import { failure } from './policy.mjs'
import { snapshotRows, snapshotText } from './snapshot.mjs'

// A locator alone is not an identity: verify it still resolves to the held node.
const locators = new WeakMap()
const states = ['checked', 'disabled', 'expanded', 'selected', 'pressed', 'active', 'invalid', 'level']

export async function observe(runtime, item, input, signal) {
  runtime.guard()
  signal?.throwIfAborted()
  if (
    (input.query !== undefined &&
      (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200)) ||
    (input.depth !== undefined && (!Number.isInteger(input.depth) || input.depth < 0 || input.depth > 20)) ||
    (input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || input.cursor < 0))
  )
    throw failure(
      'INVALID_INPUT',
      'inspect needs a nonblank query (up to 200 characters), depth 0–20 and a nonnegative cursor.',
    )
  const epoch = item.epoch,
    humanRevision = item.humanRevision,
    controlEpoch = item.controlEpoch,
    scope = input.ref ? item.refs.get(input.ref) : undefined,
    locator = scope && locators.get(scope)
  if (input.ref && (!scope || !locator || input.pageEpoch !== epoch))
    throw failure('STALE_TARGET', 'Local inspection needs a current ref and pageEpoch.')
  const assertCurrent = () => {
    runtime.guard()
    signal?.throwIfAborted()
    if (
      epoch !== item.epoch ||
      humanRevision !== item.humanRevision ||
      controlEpoch !== item.controlEpoch ||
      item.page.isClosed()
    )
      throw failure('STALE_TARGET', 'Page changed while observing. Inspect again.')
  }
  const checkScope = async () => {
    if (scope) {
      const same = await locator
        .evaluate((node, expected) => node === expected && node.isConnected, scope, { timeout: 1000 })
        .catch(() => false)
      assertCurrent()
      if (!same) throw failure('STALE_TARGET', 'The inspected region changed. Inspect the page again.')
    }
    assertCurrent()
  }
  const elements = [],
    handles = new Map()
  try {
    await checkScope()
    // Keep the old scope alive until the native read and identity check finish.
    // Read one extra level to retain truthful depthLimited reporting. Native
    // depth=0 means unlimited; plugin depth=0 means roots only. Keep our final
    // filter because pinned Playwright can expand iframes beyond this limit.
    // Search retains full-snapshot naming: shallow AI output may restore a
    // table/row name from folded descendants, changing which nodes match.
    const tree = await (locator ?? item.page).ariaSnapshotJSON({
      mode: 'ai',
      depth: input.depth === undefined || input.query !== undefined ? undefined : input.depth + 1,
      timeout: 10_000,
      signal,
    })
    await checkScope()
    runtime.clearRefs(item)
    const snapshot = snapshotRows(tree, input)
    const targets = snapshot.window.filter((row) => row.node.ref)
    // Refresh the scoped root too, so a subsequent page/query can stay scoped
    // after this observation invalidates all the previous refs.
    if (scope && snapshot.rows[0]?.node.ref && !targets.includes(snapshot.rows[0]))
      targets.unshift(snapshot.rows[0])
    for (let start = 0; start < targets.length; start += 8) {
      assertCurrent()
      const batch = await Promise.allSettled(
        targets.slice(start, start + 8).map(async (row) => {
          const target = item.page.locator('aria-ref=' + row.node.ref)
          const handle = await target.elementHandle({ timeout: 1000 })
          if (!handle) throw failure('STALE_TARGET', 'A snapshot target changed. Inspect again.')
          const ref = randomUUID()
          handles.set(ref, handle)
          locators.set(handle, target)
          row.ref = ref
          const metadata = await handle.evaluate((element) => ({
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute('type'),
          }))
          row.element = {
            ref,
            ...metadata,
            role: row.node.role,
            label: String(row.node.name ?? row.node.text ?? '').slice(0, 120),
            depth: row.depth,
            ...Object.fromEntries(
              states.filter((key) => row.node[key] !== undefined).map((key) => [key, row.node[key]]),
            ),
          }
        }),
      )
      const failed = batch.find((result) => result.status === 'rejected')
      if (failed) throw failed.reason
    }
    assertCurrent()
    for (const row of targets) elements.push(row.element)
    const rendered = snapshotText(snapshot)
    for (const [ref, handle] of handles) item.refs.set(ref, handle)
    item.uncertain = false
    item.observedHumanRevision = humanRevision
    runtime.activate(item)
    return {
      ...runtime.describe(item),
      text: rendered.text,
      elements,
      truncated: rendered.truncated || snapshot.hasMore || snapshot.depthLimited || snapshot.scanLimited,
      cursor: snapshot.cursor,
      hasMore: snapshot.hasMore,
      depthLimited: snapshot.depthLimited,
      scanLimited: snapshot.scanLimited,
      ...(input.query !== undefined ? { matchCount: snapshot.matchCount } : {}),
      ...(scope ? { scopeRef: snapshot.rows[0]?.ref } : {}),
    }
  } catch (error) {
    for (const handle of handles.values()) void handle.dispose().catch(() => {})
    runtime.clearRefs(item)
    throw error
  }
}
