import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

/**
 * session-v1.json as a release from before the delivery marker validates its rows: the same document without the
 * field. (Checked equal, definition for definition, to that release's own schema when the marker was introduced.)
 */
function preMarkerValidator(): (definition: 'Inbox' | 'UserMessage', data: unknown) => string[] {
  const document = JSON.parse(
    readFileSync(new URL('../../protocol/schema/session-v1.json', import.meta.url), 'utf8'),
  )
  delete document.$defs.InboxItem.properties.deliveredBy
  delete document.$defs.UserMessage.properties.deliveredBy
  delete document.$defs.InputDeliverer
  const ajv = new Ajv2020({ strict: false, validateFormats: false })
  ajv.addSchema(document)
  return (definition, data) => {
    const validate = ajv.getSchema(`${document.$id}#/$defs/${definition}`)
    if (!validate) throw new Error(`no definition ${definition}`)
    return validate(data)
      ? []
      : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`)
  }
}

const say = (text: string) => [
  { type: 'text_delta' as const, delta: text },
  { type: 'done' as const, reason: 'stop' as const },
]

it('writes only inbox and message rows a release from before the delivery marker accepts', async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'agh-delivery-marker-')))
  const h = await createTestHost({ dataDir, script: [say('one'), say('two'), say('three')] })
  const validate = preMarkerValidator()
  try {
    const session = await h.host.createSession({ cwd: dataDir, preset: 'standard' })
    const actor = session.d.actor
    const deliveredBy = { kind: 'bundled-app' as const, appId: '@agnes/superagent/superagent' }
    const text = (value: string) => [{ type: 'text' as const, text: value }]
    // Marked and plain input queued, one marked item edited and one removed, then every item claimed.
    for (const value of ['marked one', 'marked two', 'marked three'])
      await session.enqueue('next-turn', { content: text(value), actor, deliveredBy })
    await session.enqueue('next-turn', { content: text('plain'), actor })
    const items = () => (session.latest('inbox') as { items: Array<{ itemId: string }> }).items
    await session.controls.edit(items()[1]?.itemId ?? '', text('edited'), actor, 'edit')
    await session.removeQueuedInput(items()[2]?.itemId ?? '', actor, 'remove')
    for (let turn = 0; turn < 3; turn++)
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const rows = await session.scan({ type: ['inbox', 'user/message'], limit: 100 })
    expect(rows.filter((row) => row.type === 'inbox').length).toBeGreaterThan(4)
    expect(rows.filter((row) => row.type === 'user/message')).toHaveLength(3)
    for (const row of rows)
      expect(
        validate(row.type === 'inbox' ? 'Inbox' : 'UserMessage', row.data),
        `${row.type} #${row.seq}`,
      ).toEqual([])
    // The marker still reaches the reader, from Core's own side rows.
    const shown = (await session.projectUI()).nodes.flatMap((node) =>
      node.kind === 'user'
        ? [[node.content[0]?.type === 'text' ? node.content[0].text : '', node.deliveredBy]]
        : [],
    )
    expect(shown).toEqual([
      ['marked one', deliveredBy],
      ['edited', undefined],
      ['plain', undefined],
    ])
  } finally {
    await h.host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
