import { LEAN_DATA_MIN_CHARS } from '@agnes/core'

const MIN = LEAN_DATA_MIN_CHARS
const DATA = (block: string) => `json_extract(${block}, '$.data')`
const DECODED = (block: string) =>
  `(length(${DATA(block)}) / 4) * 3 - (CASE WHEN substr(${DATA(block)}, -2) = '==' THEN 2 WHEN substr(${DATA(block)}, -1) = '=' THEN 1 ELSE 0 END)`
// An element left as it is goes back through `->`, which hands over its JSON text as stored: reading
// `value` instead would turn `true` into 1, round reals to 15 digits and decode lone surrogates.
/** One content array, rebuilt in order, each large inline image/file block replaced by its lean form. */
const CONTENT = (source: string) => `(SELECT json_group_array(json(CASE
  WHEN b.type = 'object'
   AND json_extract(b.value, '$.type') IN ('image', 'file')
   AND json_type(b.value, '$.data') = 'text'
   AND length(${DATA('b.value')}) > ${MIN}
   AND length(${DATA('b.value')}) = octet_length(${DATA('b.value')})
  THEN json_set(json_remove(b.value, '$.data'), '$.dataOmitted', json_object('bytes', ${DECODED('b.value')}))
  ELSE ${source} -> b.fullkey END) ORDER BY b.key)
  FROM json_each(${source}, '$.content') AS b)`

/**
 * The `data` column as the lean rule in core/src/log/lean.ts would leave it, computed inside SQLite
 * so a large base64 string never enters the JavaScript heap. A row at or under the threshold cannot
 * hold a block over it, so the rewrite only runs on rows that might need it.
 *
 * Only ASCII data is rewritten here, the one case where SQLite's character count is the JS `.length`
 * (base64 always is). A block whose data holds anything else, a NUL included, comes back whole and
 * the caller finishes it with `leanEvents`, so the two rules cannot disagree.
 */
export const LEAN_DATA_COLUMN = `CASE
  WHEN octet_length(data) > ${MIN} AND type = 'user/message' AND json_type(data, '$.content') = 'array'
    THEN json_set(data, '$.content', json(${CONTENT('data')}))
  WHEN octet_length(data) > ${MIN} AND type = 'inbox' AND json_type(data, '$.items') = 'array'
    THEN json_set(data, '$.items', json((SELECT json_group_array(json(CASE
      WHEN i.type = 'object' AND json_type(i.value, '$.content') = 'array'
        THEN json_set(i.value, '$.content', json(${CONTENT('i.value')}))
      ELSE data -> i.fullkey END) ORDER BY i.key)
      FROM json_each(data, '$.items') AS i)))
  ELSE data END`

export const EVENT_COLUMNS_LEAN = `session_key, seq, ts, id, type, lane, v, actor, origin, trust, register, ignorable, surface_op, source_event_seqs, ${LEAN_DATA_COLUMN} AS data, integrity_mode, integrity_prev, integrity_digest`
