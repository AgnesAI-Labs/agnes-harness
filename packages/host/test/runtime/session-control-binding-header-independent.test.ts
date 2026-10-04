import { expect, it } from 'vitest'
import { createSessionControlSource } from '../../src/runtime/state/session-control-source.js'
import { createSessionControlSourceFixture } from './fixtures/session-control-source.js'

it('independent original RunBinding full schema revision mutation refuses capture', async () => {
  const f = await createSessionControlSourceFixture()
  try {
    await f.configuration.issueBase('ticket', f.request, f.context)
    const source = createSessionControlSource({ database: f.db, configuration: f.configuration })
    source.captureRead('session', f.context).finalCheck()
    const update = f.db
      .prepare(
        "UPDATE runtime_record_heads SET schema_json=json_set(schema_json,'$.revision',999) WHERE record_id='run-binding:run'",
      )
      .run()
    expect(update.changes).toBe(1)
    expect(
      f.db
        .prepare(
          "SELECT json_extract(schema_json,'$.revision') revision FROM runtime_record_heads WHERE record_id='run-binding:run'",
        )
        .get()?.revision,
    ).toBe(999)
    expect(() => source.captureRead('session', f.context)).toThrow()
  } finally {
    f.close()
  }
})
