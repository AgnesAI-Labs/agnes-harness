import { API_VERSION, checkManifest, type ExtensionManifest, satisfiesApiRange } from '@agnes/extension-api'
import { HostError } from '../errors.js'
import { assertCapabilityCeiling } from '../packages/capabilities.js'
import { readAuthorManifest, resolveEntry } from './manifest.js'

/** Complete admission checks, before any extension source is evaluated. */
export function preflightExtension(input: {
  id: string
  dir: string
  ceiling: readonly string[]
  apiVersion?: string
}) {
  const manifest = readAuthorManifest(input.dir, input.apiVersion)
  if (manifest.id !== input.id)
    throw new HostError('E_EXT_LOAD', 'extension identity differs from pinned spec')
  assertCapabilityCeiling(manifest, input.ceiling)
  return { manifest, entry: resolveEntry(input.dir, manifest.entry) }
}

/** Admission for a manifest compiled into the release, where no mutable entry file is involved. */
export function preflightEmbeddedExtension(input: {
  id: string
  manifest: ExtensionManifest
  ceiling: readonly string[]
  apiVersion?: string
}): ExtensionManifest {
  const checked = checkManifest(input.manifest)
  if (!checked.ok) throw new HostError('E_EXT_LOAD', 'embedded extension manifest is invalid')
  const manifest = checked.value
  if (manifest.id !== input.id)
    throw new HostError('E_EXT_LOAD', 'embedded extension identity differs from pinned spec')
  if (!satisfiesApiRange(manifest.apiRange, input.apiVersion ?? API_VERSION))
    throw new HostError('E_API_RANGE', 'embedded extension API version is incompatible')
  assertCapabilityCeiling(manifest, input.ceiling)
  return manifest
}
