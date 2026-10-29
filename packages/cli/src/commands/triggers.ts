import { readFileSync } from 'node:fs'
import { describeValidationErrors, validateAgainst } from '@agnes/protocol'
import {
  type WebhookConfig,
  WebhookConfig as WebhookConfigSchema,
  type WebhookDelivery,
  type WebhookResult,
  type WebhookRule,
  WebhookRule as WebhookRuleSchema,
} from '@agnes/protocol/gen/app-server'
import type { NodeClient } from '@agnes/sdk'
import type { TSchema } from '@sinclair/typebox'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { oneLine } from './sessions-manage.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

/** Delivery statuses that mean the rule took the event; anything else is a refusal worth exit 1. */
const TAKEN = new Set(['pending', 'accepted', 'waiting_approval', 'needs_attention', 'ran'])

/** A file, or `-` for stdin. Invalid JSON stops here, before any request is made. */
export function readJson(source: string, what: string): unknown {
  let text: string
  try {
    text = readFileSync(source === '-' ? 0 : source, 'utf8')
  } catch {
    throw new UsageError(`cannot read ${what} from ${oneLine(source)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new UsageError(`${what} is not valid JSON`)
  }
}

function checked<T>(schema: TSchema, source: string | undefined, flag: string, what: string): T {
  if (!source) throw new UsageError(`${what} needs ${flag} <file|->`)
  const result = validateAgainst<T>(schema, readJson(source, what))
  if (!result.ok)
    throw new UsageError(`${what} does not match the schema: ${describeValidationErrors(result.errors)}`)
  return result.value
}

const ruleLine = (r: WebhookRule): string =>
  [
    r.id,
    r.enabled ? 'enabled' : 'disabled',
    `${r.provider}/${r.auth}`,
    oneLine(r.event),
    oneLine(r.workspace),
  ].join('\t')

/**
 * `agh triggers`: webhook rules and the listener configuration, through the admin-tier admin.triggers
 * RPC. Rule and config JSON is checked against the protocol schema before anything is sent. `deliver`
 * is the inbound webhook action and is deliberately not offered here.
 */
export async function triggersCommand(p: ParsedArgs, client: NodeClient, io: IO): Promise<number> {
  const [action, ruleId, ...extra] = p.positional
  const call = (input: Record<string, unknown>) =>
    client.call<WebhookResult>('_agnes/v1/admin.triggers', input)
  const out = (value: unknown, text: string) => io.stdout.write(p.json ? `${JSON.stringify(value)}\n` : text)
  const needId = (usage: string): string => {
    if (!ruleId || extra.length) throw new UsageError(`triggers ${usage}`)
    return ruleId
  }
  const rules = async (): Promise<WebhookRule[]> => (await call({ action: 'list' })).snapshot?.rules ?? []

  if (action === undefined || action === 'list') {
    if (ruleId !== undefined) throw new UsageError('triggers list takes no positional arguments')
    const result = await call({ action: 'list' })
    const s = result.snapshot
    const config = s?.config
    const text = [
      config
        ? `webhook ${config.enabled ? 'enabled' : 'disabled'}\t${oneLine(config.path)}\tmax ${config.maxPayloadBytes} bytes`
        : 'webhook not configured',
      ...(s?.rules.length ? s.rules.map(ruleLine) : ['no trigger rules']),
    ]
    out(result, `${text.join('\n')}\n`)
    return ExitCode.OK
  }
  if (action === 'add' || action === 'edit') {
    const wanted = action === 'edit' ? needId('edit expects <ruleId> --file <file|->') : undefined
    if (action === 'add' && ruleId !== undefined) throw new UsageError('triggers add takes --file only')
    const rule = checked<WebhookRule>(WebhookRuleSchema, p.file, '--file', 'the rule')
    if (wanted !== undefined && rule.id !== wanted)
      throw new UsageError(`the rule id ${oneLine(rule.id)} is not ${oneLine(wanted)}`)
    const exists = (await rules()).some((r) => r.id === rule.id)
    if (exists === (action === 'add')) {
      io.stderr.write(`refused: ${action === 'add' ? 'rule_exists' : 'no_such_rule'} ${oneLine(rule.id)}\n`)
      return ExitCode.ERROR
    }
    out(await call({ action: 'upsert', rule }), `saved ${oneLine(rule.id)}\n`)
    return ExitCode.OK
  }
  if (action === 'remove') {
    const id = needId('remove expects <ruleId>')
    out(await call({ action: 'delete', ruleId: id }), `removed ${oneLine(id)}\n`)
    return ExitCode.OK
  }
  if (action === 'test') {
    const id = needId('test expects <ruleId> [--payload <file|->]')
    const payload = p.payload === undefined ? {} : readJson(p.payload, 'the payload')
    const { delivery } = await call({ action: 'test', ruleId: id, payload })
    out({ delivery }, delivery ? `${deliveryLine(delivery)}\n` : 'no delivery recorded\n')
    if (delivery && TAKEN.has(delivery.status)) return ExitCode.OK
    if (!p.json) io.stderr.write(`refused: ${delivery ? delivery.status : 'no_delivery'}\n`)
    return ExitCode.ERROR
  }
  if (action === 'configure') {
    if (ruleId !== undefined) throw new UsageError('triggers configure takes --file only')
    const config = checked<WebhookConfig>(WebhookConfigSchema, p.file, '--file', 'the configuration')
    out(await call({ action: 'configure', config }), 'configured\n')
    return ExitCode.OK
  }
  throw new UsageError('triggers expects list, add, edit, remove, test or configure')
}

const deliveryLine = (d: WebhookDelivery): string =>
  [d.status, d.reason ? oneLine(d.reason) : undefined].filter(Boolean).join('\t')
