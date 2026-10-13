import { LEAN_DATA_MIN_CHARS } from '@agnes/core'

const MIN = LEAN_DATA_MIN_CHARS
/**
 * Decoded size of the block's base64 `x.d`, already known to be ASCII. The two padding probes read
 * it as a BLOB: on TEXT a negative `substr` counts characters from the start of a string that can
 * run to hundreds of megabytes.
 */
const DECODED = `(octet_length(x.d) / 4) * 3 - (CASE
  WHEN substr(CAST(x.d AS BLOB), -2) = CAST('==' AS BLOB) THEN 2
  WHEN substr(CAST(x.d AS BLOB), -1) = CAST('=' AS BLOB) THEN 1 ELSE 0 END)`

/**
 * The content array at `path` inside `data`, rebuilt in order, each large inline image/file block
 * replaced by its lean form.
 *
 * Everything is read out of `data` by path, whose parse SQLite keeps for the statement. A block's
 * `data` string is extracted once, in the inner query; `LIMIT -1` keeps that query from being
 * flattened into the aggregate, which would evaluate the extraction again at every reference.
 * An element left as it is goes back through `->`, which hands over its JSON text as stored:
 * json_each's `value` would turn `true` into 1, round reals to 15 digits and decode lone
 * surrogates. A leaned block is cut out of the document by path for the same reason, so its keys
 * and remaining values keep their stored spelling.
 */
const CONTENT = (path: string) => `(SELECT json_group_array(json(CASE
    WHEN x.d IS NULL OR octet_length(x.d) <= ${MIN} OR length(x.d) <> octet_length(x.d) THEN data -> x.p
    ELSE json_set(json_remove(data, x.p || '.data') -> x.p, '$.dataOmitted', json_object('bytes', ${DECODED}))
    END) ORDER BY x.k)
  FROM (SELECT b.key AS k, b.fullkey AS p, CASE
      WHEN b.type = 'object'
       AND json_extract(data, b.fullkey || '.type') IN ('image', 'file')
       AND json_type(data, b.fullkey || '.data') = 'text'
      THEN json_extract(data, b.fullkey || '.data') END AS d
    FROM json_each(data, ${path}) AS b LIMIT -1) AS x)`

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
    THEN json_set(data, '$.content', json(${CONTENT(`'$.content'`)}))
  WHEN octet_length(data) > ${MIN} AND type = 'inbox' AND json_type(data, '$.items') = 'array'
    THEN json_set(data, '$.items', json((SELECT json_group_array(json(CASE
      WHEN i.type = 'object' AND json_type(data, i.fullkey || '.content') = 'array'
        THEN json_set(data -> i.fullkey, '$.content', json(${CONTENT(`i.fullkey || '.content'`)}))
      ELSE data -> i.fullkey END) ORDER BY i.key)
      FROM json_each(data, '$.items') AS i)))
  ELSE data END`

/**
 * Exactly the columns `rowToEvent` reads, with `data` in its lean form. The session key and the
 * integrity columns stay out: a lean row is never verified. A test holds this list against the
 * table, so a column added later has to be placed on one side or the other.
 */
export const EVENT_COLUMNS_LEAN_READ = [
  'seq',
  'ts',
  'id',
  'type',
  'lane',
  'v',
  'actor',
  'origin',
  'trust',
  'register',
  'ignorable',
  'surface_op',
  'source_event_seqs',
] as const
export const EVENT_COLUMNS_LEAN = `${EVENT_COLUMNS_LEAN_READ.join(', ')}, ${LEAN_DATA_COLUMN} AS data`
