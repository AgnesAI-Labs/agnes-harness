// Compiles the platform-neutral Windows ACL grant policy with the host C++ compiler and feeds it
// synthetic entries, link targets and volumes. The Windows addon reads real descriptors into the
// same shapes, so this covers the decisions without a Windows machine. Skipped when no C++
// compiler is on PATH.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { windowsAclFingerprint, windowsAclGrantEntries } from '../src/windows-acl.js'

const nativeDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'native')

function hasCompiler(): boolean {
  try {
    execFileSync('c++', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Entries are written type:flags:mask:sid in hex; "--" separates the DACL from the label list.
const driver = `#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "windows-acl-policy.h"
static std::wstring wide(const char* text) { std::wstring out; while (*text) out.push_back(static_cast<wchar_t>(*text++)); return out; }
static void put(const std::wstring& text) { for (wchar_t c : text) std::putchar(static_cast<int>(c)); }
static AclAce entry(const char* text) {
  unsigned type = 0, flags = 0; unsigned long mask = 0; char sid[128] = {};
  if (std::sscanf(text, "%x:%x:%lx:%127s", &type, &flags, &mask, sid) < 3) std::exit(2);
  return AclAce{static_cast<std::uint8_t>(type), static_cast<std::uint8_t>(flags), static_cast<std::uint32_t>(mask), wide(sid)};
}
static void lists(int argc, char** argv, int from, std::vector<AclAce>& dacl, std::vector<AclAce>& label) {
  bool second = false;
  for (int i = from; i < argc; i++) {
    if (!std::strcmp(argv[i], "--")) { second = true; continue; }
    (second ? label : dacl).push_back(entry(argv[i]));
  }
}
static void show(const std::vector<AclAce>& list) {
  for (const auto& ace : list) { std::printf("%x:%x:%lx:", ace.type, ace.flags, static_cast<unsigned long>(ace.mask)); put(ace.sid); std::printf(" "); }
}
static bool asciiEqual(const std::wstring& left, const std::wstring& right) {
  if (left.size() != right.size()) return false;
  for (size_t i = 0; i < left.size(); i++) {
    wchar_t a = left[i], b = right[i];
    if (a >= L'a' && a <= L'z') a = static_cast<wchar_t>(a - 32);
    if (b >= L'a' && b <= L'z') b = static_cast<wchar_t>(b - 32);
    if (a != b) return false;
  }
  return true;
}
int main(int argc, char** argv) {
  if (argc < 2) return 2;
  const std::string command = argv[1];
  if (command == "constants") {
    show({aclAllowEntry(wide(argv[2])), aclDenyEntry(), aclLabelEntry()});
    std::printf("%u", kAclMaxRecorded);
    return 0;
  }
  if (command == "normalize") {
    std::wstring out;
    if (aclNormalizeDrivePath(wide(argv[2]), out)) put(out); else std::fputs("refused", stdout);
    return 0;
  }
  if (command == "target") {
    std::wstring out;
    if (aclLinkTargetPath(wide(argv[2]), wide(argv[3]), !std::strcmp(argv[4], "1"), out)) put(out); else std::fputs("refused", stdout);
    return 0;
  }
  if (command == "within") {
    std::fputs(aclWithin(wide(argv[2]), wide(argv[3]), asciiEqual) ? "inside" : "outside", stdout);
    return 0;
  }
  if (command == "link") {
    const AclLinkDecision d = aclLinkDecision(argv[2][0] == '1', argv[3][0] == '1', static_cast<std::uint32_t>(std::strtoul(argv[4], nullptr, 16)), argv[5][0] == '1');
    std::printf("traverse=%d record=%d refuse=%d", d.traverse, d.record, d.refuse);
    return 0;
  }
  if (command == "plan") {
    std::vector<AclAce> dacl, label; lists(argc, argv, 3, dacl, label);
    const AclGrantPlan plan = aclPlanGrant(dacl, label, wide(argv[2]));
    if (plan.status == AclPlanStatus::SidInUse) { std::fputs("sid-in-use", stdout); return 0; }
    if (plan.status == AclPlanStatus::LabelConflict) { std::fputs("label-conflict", stdout); return 0; }
    std::printf("allow=%d deny=%d label=%d dacl=", plan.addAllow, plan.addDeny, plan.addLabel);
    show(aclGrantedDacl(dacl, plan, wide(argv[2])));
    std::printf("label=");
    show(aclGrantedLabel(label, plan));
    return 0;
  }
  if (command == "remove") {
    std::vector<AclAce> list, remove; lists(argc, argv, 2, list, remove);
    std::vector<AclAce> out;
    if (!aclWithout(list, remove, out)) { std::fputs("refused", stdout); return 0; }
    show(out);
    return 0;
  }
  if (command == "diff") {
    std::vector<AclAce> before, after; lists(argc, argv, 2, before, after);
    std::printf("added="); show(aclAdded(before, after));
    std::printf("removed="); show(aclAdded(after, before));
    return 0;
  }
  if (command == "carries") {
    std::vector<AclAce> dacl, label; lists(argc, argv, 6, dacl, label);
    std::fputs(aclCarriesGrant(dacl, label, wide(argv[2]), argv[3][0] == '1', argv[4][0] == '1', argv[5][0] == '1') ? "carries" : "missing", stdout);
    return 0;
  }
  if (command == "names") {
    std::vector<AclAce> dacl, label; lists(argc, argv, 3, dacl, label);
    std::fputs(aclNamesSid(dacl, wide(argv[2])) || aclNamesSid(label, wide(argv[2])) ? "names" : "clear", stdout);
    return 0;
  }
  if (command == "plain") {
    AclObjectShape shape{argv[2][0] == '1', argv[3][0] == '1', argv[4][0] == '1', argv[5][0] == '1', {}, {}};
    lists(argc, argv, 6, shape.dacl, shape.label);
    std::fputs(aclInheritOnly(shape) ? "plain" : "recorded", stdout);
    return 0;
  }
  if (command == "ids") {
    std::uint8_t bytes[16] = {};
    for (int i = 0; i < 16; i++) bytes[i] = static_cast<std::uint8_t>(std::strtoul(std::string(argv[3] + i * 2, 2).c_str(), nullptr, 16));
    put(aclVolumeId(std::strtoull(argv[2], nullptr, 16))); std::printf(" "); put(aclFileId(bytes));
    return 0;
  }
  if (command == "fingerprint") {
    put(aclFingerprintText(wide(argv[2]), wide(argv[3]), wide(argv[4])));
    return 0;
  }
  if (command == "volume") {
    std::fputs(aclVolumeSupported(wide(argv[2]), argv[3][0] == '1', static_cast<unsigned>(std::strtoul(argv[4], nullptr, 10))) ? "supported" : "refused", stdout);
    return 0;
  }
  return 2;
}
`

const SID = 'S-1-4-77-88'
const allow = `0:3:110156:${SID}`
const deny = '1:2:40:S-1-1-0'
const label = '11:3:1:S-1-16-4096'
const user = '0:3:1f01ff:S-1-5-21-1-2-3-1001'
const inheritedUser = '0:13:1f01ff:S-1-5-21-1-2-3-1001'
const inheritedLow = '11:13:1:S-1-16-4096'

describe.skipIf(!hasCompiler())('Windows ACL grant policy', () => {
  let workDirectory: string
  let binary: string

  beforeAll(() => {
    workDirectory = mkdtempSync(join(tmpdir(), 'agnes-windows-acl-policy-'))
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
  }, 60_000)

  afterAll(() => {
    rmSync(workDirectory, { recursive: true, force: true })
  })

  const run = (...args: string[]): string => execFileSync(binary, args, { encoding: 'utf8' }).trim()

  it('builds the same three entries the TypeScript contract describes', () => {
    const entries = windowsAclGrantEntries(SID)
      .map(({ kind, sid, mask, flags }) => {
        const type = { allow: 0, deny: 1, label: 0x11, other: -1 }[kind]
        return `${type.toString(16)}:${flags.toString(16)}:${mask.toString(16)}:${sid}`
      })
      .join(' ')
    expect(run('constants', SID)).toBe(`${entries} 100000`)
  })

  it('formats identities and the fingerprint text the TypeScript side hashes', () => {
    // FILE_ID_128 bytes in memory order; the identity reads them as one little-endian number.
    expect(run('ids', '1a2b3c4d5e6f7081', 'bc0a0000000001000000000000000000')).toBe(
      '1a2b3c4d5e6f7081 00000000000000000001000000000abc',
    )
    const identity = { volumeId: '1a2b3c4d5e6f7081', fileId: '000000000000000000010000000000ab' }
    const text = run('fingerprint', identity.volumeId, identity.fileId, 'O:BAD:PAI(A;;FA;;;SY)')
    expect(createHash('sha256').update(Buffer.from(text, 'utf16le')).digest('hex')).toBe(
      windowsAclFingerprint(identity, 'O:BAD:PAI(A;;FA;;;SY)'),
    )
  })

  it('normalizes link targets lexically and refuses anything outside a drive', () => {
    expect(run('normalize', 'C:\\ws\\.\\a\\..\\b\\')).toBe('C:\\ws\\b')
    expect(run('normalize', 'c:/ws//x')).toBe('c:\\ws\\x')
    expect(run('normalize', 'C:\\..\\x')).toBe('refused')
    expect(run('normalize', 'UNC\\server\\share')).toBe('refused')
    expect(run('normalize', 'Volume{1234}\\x')).toBe('refused')
    expect(run('target', 'C:\\ws\\node_modules', '..\\.pnpm\\pkg', '1')).toBe('C:\\ws\\.pnpm\\pkg')
    expect(run('target', 'C:\\ws\\node_modules', '\\other', '1')).toBe('C:\\other')
    expect(run('target', 'C:\\ws\\a', '\\??\\C:\\ws\\b', '0')).toBe('C:\\ws\\b')
    expect(run('target', 'C:\\ws\\a', '\\??\\Volume{1234}\\', '0')).toBe('refused')
    expect(run('target', 'C:\\ws\\a', 'C:\\ws\\b', '0')).toBe('refused')
  })

  it('treats a sibling with the same prefix as outside the root', () => {
    expect(run('within', 'C:\\ws', 'c:\\WS\\sub')).toBe('inside')
    expect(run('within', 'C:\\ws', 'C:\\ws')).toBe('inside')
    expect(run('within', 'C:\\ws', 'C:\\ws2\\sub')).toBe('outside')
    expect(run('within', 'C:\\ws', 'C:\\w')).toBe('outside')
  })

  it('follows only real directories and refuses links that leave the root', () => {
    expect(run('link', '1', '0', '0', '0')).toBe('traverse=1 record=0 refuse=0')
    expect(run('link', '0', '0', '0', '0')).toBe('traverse=0 record=0 refuse=0')
    expect(run('link', '1', '1', 'a0000003', '1')).toBe('traverse=0 record=1 refuse=0')
    expect(run('link', '0', '1', 'a000000c', '1')).toBe('traverse=0 record=1 refuse=0')
    expect(run('link', '1', '1', 'a0000003', '0')).toBe('traverse=0 record=0 refuse=1')
    expect(run('link', '0', '1', 'a000001d', '1')).toBe('traverse=0 record=0 refuse=1')
    // A cloud placeholder directory is a real container, not a name surrogate.
    expect(run('link', '1', '1', '9000001a', '0')).toBe('traverse=1 record=1 refuse=0')
    expect(run('link', '0', '1', '80000013', '0')).toBe('traverse=0 record=1 refuse=0')
  })

  it('adds the deny first, the capability after explicit entries and the label first', () => {
    expect(run('plan', SID, user, inheritedUser)).toBe(
      `allow=1 deny=1 label=1 dacl=${deny} ${user} ${allow} ${inheritedUser} label=${label}`,
    )
    expect(run('plan', SID, deny, user, allow, inheritedUser, '--', label)).toBe(
      `allow=0 deny=0 label=0 dacl=${deny} ${user} ${allow} ${inheritedUser} label=${label}`,
    )
    expect(run('plan', SID, user, '--', inheritedLow)).toBe(
      `allow=1 deny=1 label=1 dacl=${deny} ${user} ${allow} label=${label} ${inheritedLow}`,
    )
  })

  it('refuses a reused write SID and a foreign label', () => {
    expect(run('plan', SID, `0:3:1f01ff:${SID}`)).toBe('sid-in-use')
    expect(run('plan', SID, user, `1:0:1:${SID}`)).toBe('sid-in-use')
    expect(run('plan', SID, user, '--', '11:3:1:S-1-16-8192')).toBe('label-conflict')
    expect(run('plan', SID, user, '--', '11:0:1:S-1-16-4096')).toBe('label-conflict')
    expect(run('plan', SID, user, '--', '11:13:3:S-1-16-4096')).toBe('label-conflict')
    expect(run('plan', SID, user, '--', '11:13:1:S-1-16-12288')).toBe('label-conflict')
  })

  it('removes only exact explicit entries, once each, and never an inherited copy', () => {
    expect(run('remove', deny, user, allow, inheritedUser, '--', allow, deny)).toBe(
      `${user} ${inheritedUser}`,
    )
    expect(run('remove', user, `0:13:110156:${SID}`, '--', allow)).toBe('refused')
    expect(run('remove', user, allow, '--', `0:3:110157:${SID}`)).toBe('refused')
    expect(run('remove', allow, allow, '--', allow)).toBe(allow)
  })

  it('diffs entries as multisets', () => {
    expect(run('diff', user, inheritedUser, '--', user, inheritedUser, `0:13:110156:${SID}`)).toBe(
      `added=0:13:110156:${SID} removed=`,
    )
    expect(run('diff', user, user, '--', user)).toBe(`added=removed=${user}`)
  })

  it('checks what a propagated grant leaves on objects below the root', () => {
    const inheritedAllow = `0:10:110156:${SID}`
    const inheritedDeny = '1:12:40:S-1-1-0'
    expect(run('carries', SID, '0', '1', '1', inheritedAllow, '--', inheritedLow)).toBe('carries')
    expect(run('carries', SID, '1', '1', '1', `0:13:110156:${SID}`, '--', inheritedLow)).toBe('missing')
    expect(run('carries', SID, '1', '1', '1', `0:13:110156:${SID}`, inheritedDeny, '--', inheritedLow)).toBe(
      'carries',
    )
    expect(run('carries', SID, '0', '1', '1', allow, '--', inheritedLow)).toBe('missing')
    expect(run('carries', SID, '0', '1', '1', inheritedAllow)).toBe('missing')
    expect(run('carries', SID, '0', '0', '0', user)).toBe('carries')
    expect(run('names', SID, user, '--', inheritedLow)).toBe('clear')
    expect(run('names', SID, user, `0:10:110156:${SID}`)).toBe('names')
  })

  it('records every object whose descriptor inheritance alone does not determine', () => {
    expect(run('plain', '0', '0', '0', '0', inheritedUser, '--', inheritedLow)).toBe('plain')
    expect(run('plain', '0', '0', '0', '0')).toBe('plain')
    expect(run('plain', '0', '0', '0', '0', user, inheritedUser)).toBe('recorded')
    expect(run('plain', '0', '0', '0', '0', inheritedUser, '--', label)).toBe('recorded')
    expect(run('plain', '0', '1', '0', '0', inheritedUser)).toBe('recorded')
    expect(run('plain', '0', '0', '1', '0', inheritedUser)).toBe('recorded')
    expect(run('plain', '0', '0', '0', '1', inheritedUser)).toBe('recorded')
    expect(run('plain', '1', '0', '0', '0')).toBe('recorded')
  })

  it('accepts only local NTFS volumes that keep ACLs', () => {
    expect(run('volume', 'NTFS', '1', '3')).toBe('supported')
    expect(run('volume', 'NTFS', '1', '2')).toBe('supported')
    expect(run('volume', 'NTFS', '0', '3')).toBe('refused')
    expect(run('volume', 'FAT32', '0', '2')).toBe('refused')
    expect(run('volume', 'ReFS', '1', '3')).toBe('refused')
    expect(run('volume', 'NTFS', '1', '4')).toBe('refused')
    expect(run('volume', 'NTFS', '1', '5')).toBe('refused')
  })
})
