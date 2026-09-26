// Compiles the platform-neutral Windows private-descriptor policy with the host C++ compiler and
// feeds it synthetic owners and access entries. The Windows addon classifies real SIDs into the
// same principals, so this covers the decision without a Windows machine. Skipped when no C++
// compiler is on PATH.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const nativeDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'native')

function hasCompiler(): boolean {
  try {
    execFileSync('c++', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Mirrors how the addon composes the two decisions: a trusted owner and only trusted entries.
const driver = `#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "private-dacl-policy.h"
static PrivatePrincipal principal(const char* name) {
  if (!std::strcmp(name, "user")) return PrivatePrincipal::CurrentUser;
  if (!std::strcmp(name, "system")) return PrivatePrincipal::LocalSystem;
  if (!std::strcmp(name, "administrators")) return PrivatePrincipal::Administrators;
  return PrivatePrincipal::Other;
}
int main(int argc, char** argv) {
  bool valid = argc > 1 && privateOwnerTrusted(principal(argv[1]));
  for (int i = 2; valid && i < argc; i++) {
    char kind[16] = {}, who[32] = {};
    unsigned long mask = 0;
    if (std::sscanf(argv[i], "%15[^:]:%lx:%31s", kind, &mask, who) != 3) return 2;
    const PrivateAceKind parsed = !std::strcmp(kind, "allow") ? PrivateAceKind::Allowed
      : !std::strcmp(kind, "deny") ? PrivateAceKind::Denied : PrivateAceKind::Unsupported;
    valid = privateAceTrusted(PrivateAce{parsed, mask, principal(who)});
  }
  std::fputs(valid ? "trusted" : "refused", stdout);
  return 0;
}
`

describe.skipIf(!hasCompiler())('Windows private descriptor policy', () => {
  let workDirectory: string
  let binary: string

  beforeAll(() => {
    workDirectory = mkdtempSync(join(tmpdir(), 'agnes-private-dacl-policy-'))
    const source = join(workDirectory, 'driver.cc')
    binary = join(workDirectory, 'driver')
    writeFileSync(source, driver)
    execFileSync('c++', [
      '-std=c++17',
      '-Wall',
      '-Wextra',
      '-Werror',
      `-I${nativeDirectory}`,
      '-o',
      binary,
      source,
    ])
  })

  afterAll(() => {
    rmSync(workDirectory, { recursive: true, force: true })
  })

  const decide = (owner: string, ...aces: string[]): string =>
    execFileSync(binary, [owner, ...aces], { encoding: 'utf8' })
  const fullAccess = '1f01ff'
  const created = [`allow:${fullAccess}:system`, `allow:${fullAccess}:user`]

  it('accepts a descriptor owned by the current user', () => {
    expect(decide('user', ...created)).toBe('trusted')
  })

  it('accepts the Administrators default owner of an object created by an elevated token', () => {
    expect(decide('administrators', ...created)).toBe('trusted')
    expect(decide('administrators', ...created, `allow:${fullAccess}:administrators`)).toBe('trusted')
  })

  it('still refuses a foreign or SYSTEM owner', () => {
    expect(decide('other', ...created)).toBe('refused')
    expect(decide('system', ...created)).toBe('refused')
  })

  it('still refuses an extra access entry for another principal whatever the owner', () => {
    for (const owner of ['user', 'administrators']) {
      expect(decide(owner, ...created, 'allow:120089:other')).toBe('refused')
      expect(decide(owner, ...created, `unsupported:${fullAccess}:user`)).toBe('refused')
    }
  })

  it('ignores deny entries and empty grants', () => {
    expect(decide('user', ...created, `deny:${fullAccess}:other`, 'allow:0:other')).toBe('trusted')
  })
})
