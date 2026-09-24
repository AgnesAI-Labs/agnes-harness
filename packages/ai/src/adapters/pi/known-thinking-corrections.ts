import type { ThinkingLevel } from '@agnes/protocol'

/**
 * Corrections for models whose installed pi-ai catalogue entry is incomplete or wrong,
 * verified against the provider's own API docs rather than trusted blindly. Keyed by
 * model id. A present entry replaces the catalogue's reasoning/thinkingLevelMap outright:
 * only the levels listed here are offered, each mapped to the real wire value. A deployer's
 * own `thinkingEfforts` profile override (packages/host/src/configuration.ts) is a separate,
 * later layer and always wins over this table.
 *
 * DeepSeek V4 Pro and V4 Flash: reasoning_effort supports low/high/max only (no off — the
 * model always reasons; no medium). pi-ai's bundled data agrees on high/max but marks V4
 * Pro's low unsupported and both models' off supported, both wrong per DeepSeek's docs.
 * Verified 2026-09-15 against https://api-docs.deepseek.com/updates/ and
 * https://api-docs.deepseek.com/guides/thinking_mode/.
 */
export const KNOWN_THINKING_CORRECTIONS: Readonly<
  Record<string, Readonly<Partial<Record<ThinkingLevel, string>>>>
> = {
  'deepseek-v4-pro': { low: 'low', high: 'high', max: 'max' },
  'deepseek-v4-flash': { low: 'low', high: 'high', max: 'max' },
}
