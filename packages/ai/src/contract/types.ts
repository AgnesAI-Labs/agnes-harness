// Contract manifests are protocol-owned. Syntax is the data-only adapter description from AI §7.
export type { ContractManifest } from '@agnes/protocol'
export type ContractSyntax = {
  toolCallFormats: string[]
  thinkTag?: { open: string; close: string }
  chatTemplate?: string
}
