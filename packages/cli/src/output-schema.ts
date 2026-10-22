import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { escapeControl } from '@agnes/cli-tui'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { UsageError } from './errors.js'

/** A schema file larger than this is refused: it is read whole and pasted into the prompt. */
const MAX_SCHEMA_BYTES = 64 * 1024
const MAX_REPORTED = 5

export type OutputSchema = {
  /** The schema as written, compact; it goes into the prompt. */
  text: string
  validate(value: unknown): string[]
}

/**
 * Reads and compiles `--output-schema <file>` (JSON Schema 2020-12). Every failure is a usage error, so
 * a bad schema stops the run before a prompt is sent. Compiled with no loader: a `$ref` to another
 * document is a compile error, never a network fetch. `format` is not asserted.
 */
export function loadOutputSchema(file: string, cwd: string): OutputSchema {
  const path = resolve(cwd, file)
  const shown = escapeControl(file)
  let raw: string
  try {
    if (statSync(path).size > MAX_SCHEMA_BYTES)
      throw new UsageError(`--output-schema ${shown} is larger than ${MAX_SCHEMA_BYTES / 1024} KiB`)
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if (e instanceof UsageError) throw e
    throw new UsageError(`--output-schema cannot read ${shown}`)
  }
  let schema: unknown
  try {
    schema = JSON.parse(raw)
  } catch {
    throw new UsageError(`--output-schema ${shown} is not valid JSON`)
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema))
    throw new UsageError(`--output-schema ${shown} must hold a JSON object`)
  try {
    const check = new Ajv2020({
      strict: false,
      allErrors: true,
      validateFormats: false,
      logger: false,
    }).compile(schema)
    return {
      text: JSON.stringify(schema),
      validate: (value) => {
        if (check(value)) return []
        return (check.errors ?? [])
          .slice(0, MAX_REPORTED)
          .map(
            (err) =>
              `${escapeControl(err.instancePath || '/')} ${escapeControl(err.message ?? 'is invalid')}`,
          )
      },
    }
  } catch (e) {
    throw new UsageError(
      `--output-schema ${shown} is not a usable schema: ${escapeControl(String((e as Error).message))}`,
    )
  }
}

/** The fixed instruction appended to the prompt, with the schema inside it. */
export function schemaInstruction(schema: OutputSchema, locale = 'en'): string {
  return locale.startsWith('zh')
    ? `最终回复只输出一个符合下面 JSON Schema 的 JSON 值，不要附加任何说明文字，也不要用代码块包裹。\n${schema.text}`
    : `Reply with exactly one JSON value that conforms to the JSON Schema below as your final answer: no other text and no code fence.\n${schema.text}`
}

// One ```json or ``` fence around the whole reply is tolerated; anything else is not unwrapped.
const FENCED = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i

export type Structured = { ok: true; value: unknown } | { ok: false; errors: string[] }

/** The final reply as a validated JSON value, or the first few reasons it is not one. */
export function checkStructured(text: string, schema: OutputSchema): Structured {
  const trimmed = text.trim()
  const body = FENCED.exec(trimmed)?.[1] ?? trimmed
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return { ok: false, errors: ['the final reply is not valid JSON'] }
  }
  const errors = schema.validate(value)
  return errors.length ? { ok: false, errors } : { ok: true, value }
}
