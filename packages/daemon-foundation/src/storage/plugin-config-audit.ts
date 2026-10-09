import type { JsonValue, PluginConfigAudit } from '@agnes/protocol'
import type { TableHandle } from './table.js'

/** Config intent and its fact share the composite publication transaction. */
export class PluginConfigAuditStore {
  constructor(
    private readonly table: TableHandle,
    private readonly profile: string,
  ) {
    table.exec(`CREATE TABLE IF NOT EXISTS plugin_config_intents (
      profile TEXT PRIMARY KEY, expected_digest TEXT NOT NULL, target_digest TEXT NOT NULL,
      command_id TEXT NOT NULL, fact_json TEXT NOT NULL, value_json TEXT)`)
    table.exec(`CREATE TABLE IF NOT EXISTS plugin_config_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL, command_id TEXT NOT NULL,
      revision TEXT NOT NULL, fact_json TEXT NOT NULL, UNIQUE(profile, command_id))`)
    table.exec(`CREATE TABLE IF NOT EXISTS plugin_config_values (
      profile TEXT NOT NULL, package_id TEXT NOT NULL, row_id TEXT NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY(profile, package_id, row_id))`)
    // A crashed unpublished intent is not a successful change. Facts only commit with desired state.
    table.exec('DELETE FROM plugin_config_intents WHERE profile = ?', [profile])
  }

  stage(
    expected: string,
    target: string,
    commandId: string,
    fact: PluginConfigAudit,
    configuration?: { packageId: string; rowId: string; value: JsonValue },
  ): void {
    this.table.exec(
      `INSERT OR REPLACE INTO plugin_config_intents
      (profile, expected_digest, target_digest, command_id, fact_json, value_json) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        this.profile,
        expected,
        target,
        commandId,
        JSON.stringify(fact),
        configuration ? JSON.stringify(configuration) : null,
      ],
    )
  }

  /** Called inside the transaction immediately before changing the desired artifact. */
  commit(current: string | undefined, target: string): void {
    const intent = this.table.get<{
      expected_digest: string
      target_digest: string
      command_id: string
      fact_json: string
      value_json: string | null
    }>('SELECT * FROM plugin_config_intents WHERE profile = ?', [this.profile])
    if (!intent || intent.target_digest !== target) return
    if (intent.expected_digest !== current) throw new Error('E_PLUGIN_CONFIG_CONFLICT')
    this.table.exec(
      `INSERT INTO plugin_config_audit (profile, command_id, revision, fact_json)
      VALUES (?, ?, ?, ?)`,
      [this.profile, intent.command_id, target, intent.fact_json],
    )
    if (intent.value_json) {
      const saved = JSON.parse(intent.value_json) as { packageId: string; rowId: string; value: JsonValue }
      this.table.exec(
        `INSERT OR REPLACE INTO plugin_config_values (profile, package_id, row_id, value_json)
        VALUES (?, ?, ?, ?)`,
        [this.profile, saved.packageId, saved.rowId, JSON.stringify(saved.value)],
      )
    }
    this.clear()
  }

  value(packageId: string, rowId: string): JsonValue | undefined {
    const saved = this.table.get<{ value_json: string }>(
      'SELECT value_json FROM plugin_config_values WHERE profile = ? AND package_id = ? AND row_id = ?',
      [this.profile, packageId, rowId],
    )
    return saved ? (JSON.parse(saved.value_json) as JsonValue) : undefined
  }

  clear(): void {
    this.table.exec('DELETE FROM plugin_config_intents WHERE profile = ?', [this.profile])
  }

  facts(rowIds: readonly string[]): PluginConfigAudit[] {
    return this.table
      .all<{ fact_json: string }>(
        'SELECT fact_json FROM plugin_config_audit WHERE profile = ? ORDER BY seq DESC LIMIT 100',
        [this.profile],
      )
      .map((row) => JSON.parse(row.fact_json) as PluginConfigAudit)
      .filter((fact) => rowIds.includes(fact.rowId))
      .slice(0, 20)
  }
}
