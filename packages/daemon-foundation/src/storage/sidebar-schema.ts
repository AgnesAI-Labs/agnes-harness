import type { TableHandle } from './table.js'

/** All triggers stay in the existing daemon owner database and commit with the changing row.
 * Import and older CLI writers therefore invalidate pages without an in-process notification. */
export function ensureSidebarSchema(t: TableHandle): void {
  t.exec(`CREATE TABLE IF NOT EXISTS sidebar_versions (
    principal_id TEXT NOT NULL, group_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (principal_id, group_id))`)
  t.exec(
    'CREATE INDEX IF NOT EXISTS sidebar_order ON session_workspaces (sidebar_group, sidebar_sort_at DESC, session_key DESC)',
  )
  t.exec('CREATE INDEX IF NOT EXISTS sidebar_cwd ON session_workspaces (cwd)')
  t.exec(
    'CREATE INDEX IF NOT EXISTS sidebar_owner ON session_principal_ownership (principal_id, reservation_state, session_id)',
  )
  t.exec(`UPDATE session_workspaces SET sidebar_group = COALESCE(
    (SELECT workspace_id FROM workspace_registry WHERE path = cwd AND listed = 1), 'unassigned')
    WHERE sidebar_group IS NOT COALESCE((SELECT workspace_id FROM workspace_registry WHERE path = cwd AND listed = 1), 'unassigned')`)
  const trigger = (name: string, on: string, body: string) => {
    // The caller's schema transaction keeps old writers from seeing partial trigger updates.
    t.exec(`DROP TRIGGER IF EXISTS sidebar_${name}`)
    t.exec(`CREATE TRIGGER sidebar_${name} ${on} BEGIN ${body} END`)
  }
  const bump = (key: string, groups: string) => `UPDATE sidebar_versions SET revision = revision + 1
    WHERE principal_id IN (SELECT principal_id FROM session_principal_ownership WHERE session_id = ${key})
    AND group_id IN (${groups});`
  const group = (key: string) => `(SELECT sidebar_group FROM session_workspaces WHERE session_key = ${key})`
  // A pinned session is listed in the pinned group, so its changes also invalidate that group.
  const pinned = (key: string) =>
    `(SELECT 'pinned' FROM session_preferences WHERE session_key = ${key} AND pinned_at IS NOT NULL)`
  trigger(
    'session_insert',
    'AFTER INSERT ON session_workspaces',
    `
    UPDATE session_workspaces SET sidebar_group = COALESCE(
      (SELECT workspace_id FROM workspace_registry WHERE path = NEW.cwd AND listed = 1), 'unassigned') WHERE session_key = NEW.session_key;
    ${bump('NEW.session_key', `${group('NEW.session_key')}, ${pinned('NEW.session_key')}`)}`,
  )
  trigger(
    'session_delete',
    'AFTER DELETE ON session_workspaces',
    bump('OLD.session_key', `OLD.sidebar_group, ${pinned('OLD.session_key')}`),
  )
  trigger(
    'session_update',
    `AFTER UPDATE ON session_workspaces WHEN
    OLD.sidebar_group IS NOT NEW.sidebar_group OR OLD.sidebar_sort_at IS NOT NEW.sidebar_sort_at OR
    OLD.created_at IS NOT NEW.created_at OR
    (OLD.message_seq = OLD.last_seq AND OLD.message_seq >= OLD.sidebar_target_seq) IS NOT
    (NEW.message_seq = NEW.last_seq AND NEW.message_seq >= NEW.sidebar_target_seq) OR OLD.sidebar_failed IS NOT NEW.sidebar_failed`,
    bump('NEW.session_key', `OLD.sidebar_group, NEW.sidebar_group, ${pinned('NEW.session_key')}`),
  )
  for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
    const row = action === 'DELETE' ? 'OLD' : 'NEW'
    const condition =
      action === 'UPDATE'
        ? ' WHEN OLD.archived IS NOT NEW.archived OR OLD.pinned_at IS NOT NEW.pinned_at'
        : ` WHEN ${row}.archived != 0 OR ${row}.pinned_at IS NOT NULL`
    // Pinning moves a row between its workspace group and the pinned group: both change.
    const pin =
      action === 'UPDATE'
        ? "CASE WHEN OLD.pinned_at IS NOT NULL OR NEW.pinned_at IS NOT NULL THEN 'pinned' END"
        : `CASE WHEN ${row}.pinned_at IS NOT NULL THEN 'pinned' END`
    trigger(
      `preferences_${action.toLowerCase()}`,
      `AFTER ${action} ON session_preferences${condition}`,
      bump(`${row}.session_key`, `${group(`${row}.session_key`)}, ${pin}`),
    )
    const changed =
      action === 'UPDATE'
        ? ' WHEN OLD.reservation_state IS NOT NEW.reservation_state OR OLD.principal_id IS NOT NEW.principal_id'
        : ''
    trigger(
      `ownership_${action.toLowerCase()}`,
      `AFTER ${action} ON session_principal_ownership${changed}`,
      `UPDATE sidebar_versions SET revision = revision + 1 WHERE group_id IN (${group(`${row}.session_id`)}, ${pinned(`${row}.session_id`)})
       AND principal_id IN (${action === 'UPDATE' ? 'OLD.principal_id, NEW.principal_id' : `${row}.principal_id`});`,
    )
  }
  trigger(
    'workspace_insert',
    'AFTER INSERT ON workspace_registry',
    "UPDATE session_workspaces SET sidebar_group = CASE WHEN NEW.listed = 1 THEN NEW.workspace_id ELSE 'unassigned' END WHERE cwd = NEW.path;",
  )
  trigger(
    'workspace_delete',
    'AFTER DELETE ON workspace_registry',
    "UPDATE session_workspaces SET sidebar_group = 'unassigned' WHERE cwd = OLD.path;",
  )
  trigger(
    'workspace_update',
    'AFTER UPDATE ON workspace_registry WHEN OLD.path IS NOT NEW.path OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.listed IS NOT NEW.listed',
    `UPDATE session_workspaces SET sidebar_group = COALESCE(
      (SELECT workspace_id FROM workspace_registry WHERE path = cwd AND listed = 1), 'unassigned') WHERE cwd IN (OLD.path, NEW.path);`,
  )
}
