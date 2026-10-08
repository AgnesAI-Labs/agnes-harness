import { fetchSource, type PackageSourceAdapter } from '@agnes/package-manager'

/** Resolve only daemon-created proposal identities against private storage, never model paths. */
export function pluginProposalSourceAdapter(directory: string): PackageSourceAdapter {
  return {
    type: 'file',
    fetch(source, into, options) {
      const reserved = source.ref.startsWith('file:./plugin-onboarding/')
      if (reserved && !/^file:\.\/plugin-onboarding\/sources\/plugin-[a-f0-9-]{36}$/.test(source.ref))
        throw new Error('Invalid plugin proposal source')
      return fetchSource(source, into, { ...options, cwd: reserved ? directory : options.cwd })
    },
  }
}
