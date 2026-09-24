import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HostError } from '../errors.js'
import { createWin32Platform } from './platform.js'
import { readWindowsSecret } from './secrets-win32.js'

export type SecretResolver = { kind: 'file' | 'env' | 'composite'; resolve(ref: string): string }
// Anchored, and neither half admits a separator, so a reference can never be joined into a path
// outside the store directory.
const REF = /^secret:\/\/([a-z0-9-]+)\/([a-z0-9._-]+)$/
const windows = createWin32Platform().matches()

function readCheckedFile(file: string, ref: string, check: boolean): string {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(file)
  } catch {
    throw new HostError('E_SECRET_UNRESOLVED', `${ref} not found in file store`, {
      detail: { ref, kind: 'file' },
    })
  }
  if (check && (st.mode & 0o077) !== 0)
    throw new HostError('E_SECRET_UNRESOLVED', `${ref} file mode too open (need 0600)`, {
      detail: { ref, kind: 'file', reason: 'mode' },
    })
  return readFileSync(file, 'utf8')
}

export function parseSecretRef(ref: string): { ns: string; name: string } {
  const m = REF.exec(ref)
  if (!m)
    throw new HostError('E_SECRET_UNRESOLVED', 'not a secret reference', { detail: { reason: 'bad-ref' } })
  return { ns: m[1] as string, name: m[2] as string }
}

export function createSecretsFile(opts: { dir: string; checkMode?: boolean }): SecretResolver {
  const check = opts.checkMode ?? true
  return {
    kind: 'file',
    resolve(ref) {
      const { ns, name } = parseSecretRef(ref)
      const file = join(opts.dir, ns, name)
      const raw = (
        windows && check ? readWindowsSecret(opts.dir, ns, name, ref) : readCheckedFile(file, ref, check)
      ).replace(/\r?\n$/, '')
      // The credential writer stores API keys as a versioned envelope in this same file store.
      // Keep the generic secret-file format (plain text) intact, but unwrap the one managed shape
      // before it reaches the wire adapter. This is the final persistence-to-request seam: passing
      // the JSON envelope through would authenticate with the envelope, not with the user's key.
      if (raw.trimStart().startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const value = parsed as Record<string, unknown>
            if (value.kind === 'api-key') {
              if (
                Object.keys(value).sort().join(',') !== 'kind,provider,value,version' ||
                value.version !== 1 ||
                value.kind !== 'api-key' ||
                value.provider !== ns ||
                typeof value.value !== 'string' ||
                !/\P{C}/u.test(value.value.trim())
              )
                throw new HostError('E_SECRET_UNRESOLVED', `${ref} has an invalid credential envelope`, {
                  detail: { ref, kind: 'file', reason: 'schema' },
                })
              return value.value
            }
          }
        } catch (e) {
          if (e instanceof HostError) throw e
          // Arbitrary non-managed secret files retain their original plain-text semantics.
          return raw
        }
      }
      return raw
    },
  }
}

export function createSecretsEnv(): SecretResolver {
  return {
    kind: 'env',
    resolve(ref) {
      const { ns, name } = parseSecretRef(ref)
      const key = `AGNES_SECRET_${ns}_${name}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
      const v = process.env[key]
      if (v === undefined)
        throw new HostError('E_SECRET_UNRESOLVED', `${ref} not in environment`, {
          detail: { ref, kind: 'env', key },
        })
      return v
    },
  }
}

export function composeSecrets(...rs: SecretResolver[]): SecretResolver {
  return {
    kind: 'composite',
    resolve(ref) {
      // Parsed once up front: a malformed reference is the caller's mistake, not a miss to be tried
      // against every store in turn.
      parseSecretRef(ref)
      let last: unknown
      for (const r of rs) {
        try {
          return r.resolve(ref)
        } catch (e) {
          last = e
          // A refusal is not a miss. A resolver states `reason` when it decided against answering -
          // a malformed reference, or a file the operator has left readable by other users - and
          // that decision has to be carried out rather than shopped to the next store: the 0600
          // check is defeated the moment an environment fallback can paper over it, and the
          // operator is never told. A store that simply has nothing states no reason, and that is
          // the only case this loop continues on, so a reason added later fails closed.
          if (e instanceof HostError && e.detail?.reason !== undefined) throw e
        }
      }
      throw new HostError('E_SECRET_UNRESOLVED', `${ref} unresolved by ${rs.map((r) => r.kind).join(',')}`, {
        detail: { ref, last: last instanceof HostError ? last.detail : undefined },
      })
    },
  }
}
