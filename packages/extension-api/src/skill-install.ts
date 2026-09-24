/** A request-only capability. Host approval, not plugin metadata, authorizes installation. */
export type SkillInstallRequest =
  | Readonly<{ action: 'prepare'; sourceDirectory: string; scope: 'workspace' | 'user'; enable: boolean }>
  | Readonly<{ action: 'commit' | 'status' | 'cancel'; proposalId: string }>

export type SkillInstallResult = Readonly<{
  proposalId: string
  state: 'prepared' | 'running' | 'ready' | 'installed' | 'failed' | 'cancelled' | 'interrupted'
  name?: string
  digest?: string
  fileCount?: number
  scope?: 'workspace' | 'user'
  resourceId?: string
  revision?: string
  phase?: string
  /** Existing resource-control operation, retained when completion is uncertain. */
  resourceOperationId?: string
  message?: string
  /** A running turn keeps its existing Skill snapshot. */
  effective?: 'next-turn'
}>

export type SkillInstallPort = Readonly<{
  request(input: SkillInstallRequest): Promise<SkillInstallResult>
}>
