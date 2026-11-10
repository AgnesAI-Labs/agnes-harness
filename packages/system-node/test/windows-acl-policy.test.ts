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
// On Windows, stdout starts in text mode and would turn every "\n" into "\r\n"; the driver prints
// in binary mode so its text is byte for byte what the policy produced.
const driver = `#include <cstdio>
#include <cstdlib>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
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
// Splits the entries after \`from\` into groups separated by "--".
static std::vector<std::vector<AclAce>> groups(int argc, char** argv, int from, std::size_t count) {
  std::vector<std::vector<AclAce>> out(count);
  std::size_t group = 0;
  for (int i = from; i < argc; i++) {
    if (!std::strcmp(argv[i], "--")) { if (++group >= count) std::exit(2); continue; }
    out[group].push_back(entry(argv[i]));
  }
  return out;
}
static std::vector<std::wstring> words(int argc, char** argv, int from, std::size_t count, std::size_t which) {
  std::vector<std::wstring> out;
  std::size_t group = 0;
  for (int i = from; i < argc; i++) {
    if (!std::strcmp(argv[i], "--")) { ++group; continue; }
    if (group == which) out.push_back(wide(argv[i]));
  }
  if (group + 1 > count) std::exit(2);
  return out;
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
#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);
#endif
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
    if (plan.status == AclPlanStatus::BroadWrite) { std::fputs("broad-write", stdout); return 0; }
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
  if (command == "broad") {
    std::vector<AclAce> dacl, label; lists(argc, argv, 2, dacl, label);
    std::fputs(aclBroadWrite(dacl) ? "broad" : "clear", stdout);
    return 0;
  }
  if (command == "holdable") {
    std::fputs(aclHoldableDirectory(argv[2][0] == '1', static_cast<std::uint32_t>(std::strtoul(argv[3], nullptr, 16))) ? "hold" : "refuse", stdout);
    return 0;
  }
  if (command == "inherits") {
    // container daclProtected labelProtected owner group parentDacl -- parentLabel -- childDacl -- childLabel
    const auto lists4 = groups(argc, argv, 7, 4);
    std::fputs(aclInheritanceMatches(lists4[0], lists4[1], lists4[2], lists4[3], wide(argv[5]), wide(argv[6]), argv[2][0] == '1', argv[3][0] == '1', argv[4][0] == '1') ? "matches" : "stale", stdout);
    return 0;
  }
  if (command == "owned") {
    put(aclOwnedText(wide(argv[2]), wide(argv[3]), wide(argv[4]), wide(argv[5]), argv[6][0] == '1', argv[7][0] == '1', words(argc, argv, 8, 2, 0), words(argc, argv, 8, 2, 1)));
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

  it('refuses a root whose existing entries let every confined process write', () => {
    const everyoneWrite = '0:3:1f01ff:S-1-1-0'
    expect(run('plan', SID, user, everyoneWrite)).toBe('broad-write')
    expect(run('plan', SID, user, '0:13:2:S-1-1-0')).toBe('broad-write')
    expect(run('plan', SID, user, '0:b:10000000:S-1-5-5-0-12345')).toBe('broad-write')
    expect(run('plan', SID, user, '0:13:1200a9:S-1-1-0', '0:13:1200a9:S-1-5-5-0-1')).toBe(
      `allow=1 deny=1 label=1 dacl=${deny} ${user} ${allow} 0:13:1200a9:S-1-1-0 0:13:1200a9:S-1-5-5-0-1 label=${label}`,
    )
    // Denies, labels and principals outside the confined token's restricting list do not count.
    expect(run('broad', '1:3:1f01ff:S-1-1-0', '0:3:1f01ff:S-1-5-11', '0:3:1f01ff:S-1-5-32-545')).toBe('clear')
    expect(run('broad', '0:0:40000:S-1-5-5-0-9')).toBe('broad')
    expect(run('broad', '0:0:80000:S-1-1-0')).toBe('broad')
    expect(run('broad', '0:0:10000:S-1-1-0')).toBe('broad')
    expect(run('broad', '0:0:40:S-1-1-0')).toBe('broad')
    expect(run('broad', '0:0:120089:S-1-1-0', '0:0:120089:S-1-5-5-0-9')).toBe('clear')
  })

  it('holds real directories and cloud placeholders but no name surrogate', () => {
    expect(run('holdable', '0', '0')).toBe('hold')
    expect(run('holdable', '1', '9000001a')).toBe('hold')
    expect(run('holdable', '1', '9000701a')).toBe('hold')
    expect(run('holdable', '1', 'a0000003')).toBe('refuse')
    expect(run('holdable', '1', 'a000000c')).toBe('refuse')
    expect(run('holdable', '1', 'a000001d')).toBe('refuse')
  })

  it('finds inherited entries the current parent would not produce', () => {
    const owner = 'S-1-5-21-1-2-3-1001'
    const group = 'S-1-5-21-1-2-3-513'
    const ok = (...args: string[]) => run('inherits', '1', '0', '0', owner, group, ...args)
    // A parent's inheritable entries reach a directory as inherited, keeping OI/CI.
    const system = '0:3:1f01ff:S-1-5-18'
    expect(ok(system, '--', '--', '0:13:1f01ff:S-1-5-18', '--')).toBe('matches')
    // An entry the parent no longer has (a folder moved from elsewhere on the volume) is stale.
    expect(ok(system, '--', '--', '0:13:1f01ff:S-1-5-18', '0:13:1f01ff:S-1-5-21-9-9-9-1001', '--')).toBe(
      'stale',
    )
    // So is a missing one.
    expect(ok(system, '0:3:1200a9:S-1-5-32-545', '--', '--', '0:13:1f01ff:S-1-5-18', '--')).toBe('stale')
    // Explicit entries of the child are its own, never compared with the parent.
    expect(ok(system, '--', '--', '0:13:1f01ff:S-1-5-18', `0:3:1f01ff:${owner}`, '--')).toBe('matches')
    // CREATOR OWNER and generic rights split into an effective entry and an inherit-only one.
    expect(
      ok('0:b:10000000:S-1-3-0', '--', '--', `0:10:1f01ff:${owner}`, '0:1b:10000000:S-1-3-0', '--'),
    ).toBe('matches')
    expect(ok('0:b:10000000:S-1-3-0', '--', '--', '0:1b:10000000:S-1-3-0', '--')).toBe('stale')
    expect(
      ok('0:b:e0010000:S-1-5-11', '--', '--', '0:10:1301bf:S-1-5-11', '0:1b:e0010000:S-1-5-11', '--'),
    ).toBe('matches')
    // Inherit-only for files: a directory keeps it inherit-only; this-folder-only entries stay behind.
    expect(
      ok('0:9:1200a9:S-1-5-32-545', '0:0:4:S-1-5-11', '--', '--', '0:19:1200a9:S-1-5-32-545', '--'),
    ).toBe('matches')
    // No-propagate: the directory gets the effective entry only.
    expect(ok('0:7:1200a9:S-1-5-32-545', '--', '--', '0:10:1200a9:S-1-5-32-545', '--')).toBe('matches')
    // Files take object-inherit entries as effective entries only.
    expect(
      run(
        'inherits',
        '0',
        '0',
        '0',
        owner,
        group,
        system,
        '0:2:1200a9:S-1-5-32-545',
        '--',
        '--',
        '0:10:1f01ff:S-1-5-18',
        '--',
      ),
    ).toBe('matches')
    // Labels inherit the same way.
    const medium = '11:3:1:S-1-16-8192'
    const inheritedMedium = '11:13:1:S-1-16-8192'
    expect(ok(system, '--', medium, '--', '0:13:1f01ff:S-1-5-18', '--', inheritedMedium)).toBe('matches')
    expect(ok(system, '--', '--', '0:13:1f01ff:S-1-5-18', '--', inheritedMedium)).toBe('stale')
    // A protected DACL or label inherits nothing, so its entries are not compared.
    expect(
      run(
        'inherits',
        '1',
        '1',
        '1',
        owner,
        group,
        system,
        '--',
        '--',
        '0:13:1f01ff:S-1-5-21-9',
        '--',
        inheritedLow,
      ),
    ).toBe('matches')
    // Entries a grant propagates are the grant's own and are rewritten by its change anyway.
    expect(
      ok(
        system,
        '--',
        '--',
        '0:13:1f01ff:S-1-5-18',
        `0:13:110156:${SID}`,
        '1:12:40:S-1-1-0',
        '--',
        inheritedLow,
      ),
    ).toBe('matches')
  })

  it('fingerprints only what a grant owns on its root', () => {
    expect(
      run(
        'owned',
        '1a2b',
        '3c4d',
        'S-1-5-21-1',
        'S-1-5-21-2',
        '1',
        '0',
        '00031400',
        '01021400',
        '--',
        '11031400',
      ),
    ).toBe(
      'agnes-windows-acl-owned-v1\n1a2b\n3c4d\nO:S-1-5-21-1\nG:S-1-5-21-2\nD:P:00031400,01021400\nS:-:11031400',
    )
    expect(run('owned', '1a2b', '3c4d', 'S-1-5-21-1', 'S-1-5-21-2', '0', '1', '--')).toBe(
      'agnes-windows-acl-owned-v1\n1a2b\n3c4d\nO:S-1-5-21-1\nG:S-1-5-21-2\nD:-:\nS:P:',
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
    // An inner root granted first keeps its own Low label; the system then does not add the outer
    // root's label next to it, and the object is at Low integrity either way.
    expect(run('carries', SID, '1', '1', '1', `0:13:110156:${SID}`, inheritedDeny, '--', label)).toBe(
      'carries',
    )
    expect(
      run('carries', SID, '1', '1', '1', `0:13:110156:${SID}`, inheritedDeny, '--', '11:b:1:S-1-16-4096'),
    ).toBe('missing')
    expect(
      run('carries', SID, '1', '1', '1', `0:13:110156:${SID}`, inheritedDeny, '--', '11:3:3:S-1-16-4096'),
    ).toBe('missing')
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
