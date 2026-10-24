// Language servers get an allowlisted environment, never the worker's own: that one can hold model
// and provider credentials. `PATH` and `HOME` are what finding the toolchain needs; the rest are the
// per-language locations a server cannot run without.
const ALLOWED = new Set([
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'GOPATH',
  'GOMODCACHE',
  'GOFLAGS',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'VIRTUAL_ENV',
])

export function serverEnv(source: Readonly<Record<string, string | undefined>> = process.env) {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && (ALLOWED.has(name) || name.startsWith('LC_'))) env[name] = value
  return env
}
