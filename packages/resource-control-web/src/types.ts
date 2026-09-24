import type {
  McpServerDefinitionInput,
  McpServerDescriptor,
  McpStatus,
  McpToolCatalogPage,
  ResourceDescriptor,
  ResourceOperation,
  ResourceOperationReceipt,
  SkillDescriptor,
} from '@agnes/protocol'

export type ResourceAdminContext = Readonly<{
  profile: string
  clientId: string
  permissions: readonly string[]
  readOnly: boolean
}>

export type ResourceAdminError = Readonly<{
  code: string
  message: string
}>

export type {
  McpServerDefinitionInput,
  McpServerDescriptor,
  McpStatus,
  McpToolCatalogPage,
  ResourceDescriptor,
  ResourceOperation,
  ResourceOperationReceipt,
  SkillDescriptor,
}
