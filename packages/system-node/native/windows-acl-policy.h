#pragma once
// Platform-neutral decisions for the Windows workspace write grant. The Windows caller reads real
// descriptors, reparse data and volume facts into these shapes; this header only decides, so the
// rules can be compiled and tested on any platform with synthetic entries.
//
// The grant shape (a capability allow entry, an Everyone delete-child deny and a Low no-write-up
// label) follows the write-restricted ACL backend of DeepSeek Harness
// (packages/sandbox/sandbox-windows-acl), MIT License, Copyright (c) 2026 DeepSeek; see
// DEEPSEEK-LICENSE.txt in this directory.
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

constexpr std::uint8_t kAclAllowType = 0x00;
constexpr std::uint8_t kAclDenyType = 0x01;
constexpr std::uint8_t kAclLabelType = 0x11;
constexpr std::uint8_t kAclObjectInherit = 0x01;
constexpr std::uint8_t kAclContainerInherit = 0x02;
constexpr std::uint8_t kAclInherited = 0x10;
// Write data, append, extended attributes, attributes, delete, delete child and synchronize.
// READ_CONTROL, WRITE_DAC and WRITE_OWNER stay out, so a confined child can neither rewrite an
// ACL nor take ownership to escape the grant.
constexpr std::uint32_t kAclGrantMask = 0x00110156;
constexpr std::uint32_t kAclDeleteChild = 0x00000040;
constexpr std::uint32_t kAclNoWriteUp = 0x00000001;
constexpr std::uint32_t kAclNameSurrogate = 0x20000000;
constexpr std::uint32_t kAclTagMountPoint = 0xA0000003;
constexpr std::uint32_t kAclTagSymlink = 0xA000000C;
constexpr std::uint32_t kAclSymlinkRelative = 0x00000001;
// Objects whose descriptor inheritance does not determine are kept in full; a tree with more of
// them than this is refused rather than snapshotted without bound.
constexpr unsigned kAclMaxRecorded = 100000;

struct AclAce {
  std::uint8_t type;
  std::uint8_t flags;
  std::uint32_t mask;
  std::wstring sid;  // Empty for entry types the grant never inspects.
};

inline bool aclSame(const AclAce& left, const AclAce& right) {
  return left.type == right.type && left.flags == right.flags && left.mask == right.mask && left.sid == right.sid;
}
inline bool aclExplicit(const AclAce& ace) { return (ace.flags & kAclInherited) == 0; }

inline AclAce aclAllowEntry(const std::wstring& writeSid) {
  return AclAce{kAclAllowType, kAclObjectInherit | kAclContainerInherit, kAclGrantMask, writeSid};
}
// Windows also authorizes a delete through the parent's FILE_DELETE_CHILD, which a write-restricted
// token's second access check never reaches. Denying it to Everyone on directories leaves the
// object's own DELETE right as the only way to delete inside the grant. Files never inherit it:
// the bit is part of FILE_ALL_ACCESS and would refuse every full-access open.
inline AclAce aclDenyEntry() {
  return AclAce{kAclDenyType, kAclContainerInherit, kAclDeleteChild, L"S-1-1-0"};
}
inline AclAce aclLabelEntry() {
  return AclAce{kAclLabelType, kAclObjectInherit | kAclContainerInherit, kAclNoWriteUp, L"S-1-16-4096"};
}

enum class AclPlanStatus { Ready, SidInUse, LabelConflict };
struct AclGrantPlan {
  AclPlanStatus status;
  bool addAllow;
  bool addDeny;
  bool addLabel;
};

// An entry that already stands exactly is shared rather than added again. Any other use of the
// write SID means it is not a fresh grant identity. A different label, explicit or inherited, is
// another party's integrity policy and is never replaced; an inherited Low label from an enclosing
// grant is kept and ours is added in front of it.
inline AclGrantPlan aclPlanGrant(const std::vector<AclAce>& dacl, const std::vector<AclAce>& label,
                                 const std::wstring& writeSid) {
  AclGrantPlan plan{AclPlanStatus::Ready, true, true, true};
  const AclAce allow = aclAllowEntry(writeSid), deny = aclDenyEntry(), low = aclLabelEntry();
  for (const auto& ace : dacl) {
    if (aclSame(ace, allow)) plan.addAllow = false;
    else if (ace.sid == writeSid) plan.status = AclPlanStatus::SidInUse;
    if (aclSame(ace, deny)) plan.addDeny = false;
  }
  for (const auto& ace : label) {
    if (ace.sid == writeSid) plan.status = AclPlanStatus::SidInUse;
    if (aclSame(ace, low)) plan.addLabel = false;
    else if (aclExplicit(ace) || ace.type != low.type || ace.mask != low.mask || ace.sid != low.sid)
      if (plan.status == AclPlanStatus::Ready) plan.status = AclPlanStatus::LabelConflict;
  }
  return plan;
}

// Explicit entries come first in a canonical ACL. The deny goes in front of everything and the
// capability after the last explicit entry, so a canonical ACL stays canonical and every existing
// entry keeps its relative order. `ace` projects an element to its entry, so the Windows caller
// can lay out the original entry bytes with the same rule.
template <typename T, typename Project>
inline std::vector<T> aclGrantedDaclOf(const std::vector<T>& dacl, const AclGrantPlan& plan, const T& allow,
                                       const T& deny, Project ace) {
  std::vector<T> out;
  if (plan.addDeny) out.push_back(deny);
  std::size_t index = 0;
  for (; index < dacl.size() && aclExplicit(ace(dacl[index])); ++index) out.push_back(dacl[index]);
  if (plan.addAllow) out.push_back(allow);
  for (; index < dacl.size(); ++index) out.push_back(dacl[index]);
  return out;
}
template <typename T>
inline std::vector<T> aclGrantedLabelOf(const std::vector<T>& label, const AclGrantPlan& plan, const T& low) {
  std::vector<T> out;
  if (plan.addLabel) out.push_back(low);
  out.insert(out.end(), label.begin(), label.end());
  return out;
}
inline std::vector<AclAce> aclGrantedDacl(const std::vector<AclAce>& dacl, const AclGrantPlan& plan,
                                          const std::wstring& writeSid) {
  return aclGrantedDaclOf(dacl, plan, aclAllowEntry(writeSid), aclDenyEntry(), [](const AclAce& ace) { return ace; });
}
inline std::vector<AclAce> aclGrantedLabel(const std::vector<AclAce>& label, const AclGrantPlan& plan) {
  return aclGrantedLabelOf(label, plan, aclLabelEntry());
}

// Removes each requested entry once, matching only an exact explicit entry. Fails without a
// result when any requested entry is no longer present exactly.
inline bool aclRemovalIndices(const std::vector<AclAce>& list, const std::vector<AclAce>& remove,
                              std::vector<bool>& removed) {
  removed.assign(list.size(), false);
  for (const auto& wanted : remove) {
    bool found = false;
    for (std::size_t i = 0; i < list.size() && !found; ++i) {
      if (removed[i] || !aclExplicit(list[i]) || !aclSame(list[i], wanted)) continue;
      removed[i] = true;
      found = true;
    }
    if (!found) return false;
  }
  return true;
}
inline bool aclWithout(const std::vector<AclAce>& list, const std::vector<AclAce>& remove, std::vector<AclAce>& out) {
  std::vector<bool> removed;
  if (!aclRemovalIndices(list, remove, removed)) return false;
  out.clear();
  for (std::size_t i = 0; i < list.size(); ++i)
    if (!removed[i]) out.push_back(list[i]);
  return true;
}

// Entries of `after` not matched one-for-one by an equal entry of `before`.
inline std::vector<AclAce> aclAdded(const std::vector<AclAce>& before, const std::vector<AclAce>& after) {
  std::vector<bool> used(before.size(), false);
  std::vector<AclAce> out;
  for (const auto& ace : after) {
    bool matched = false;
    for (std::size_t i = 0; i < before.size() && !matched; ++i) {
      if (used[i] || !aclSame(before[i], ace)) continue;
      used[i] = true;
      matched = true;
    }
    if (!matched) out.push_back(ace);
  }
  return out;
}

inline bool aclHasInherited(const std::vector<AclAce>& list, const AclAce& wanted) {
  for (const auto& ace : list)
    if (!aclExplicit(ace) && ace.type == wanted.type && ace.mask == wanted.mask && ace.sid == wanted.sid) return true;
  return false;
}
// Whether an object below the root carries what the root grant propagates to it. The flags say
// whether the object's DACL and label still inherit along the path from the root.
inline bool aclCarriesGrant(const std::vector<AclAce>& dacl, const std::vector<AclAce>& label,
                            const std::wstring& writeSid, bool directory, bool inheritsDacl, bool inheritsLabel) {
  if (inheritsDacl && !aclHasInherited(dacl, aclAllowEntry(writeSid))) return false;
  if (inheritsDacl && directory && !aclHasInherited(dacl, aclDenyEntry())) return false;
  return !inheritsLabel || aclHasInherited(label, aclLabelEntry());
}
inline bool aclNamesSid(const std::vector<AclAce>& list, const std::wstring& sid) {
  for (const auto& ace : list)
    if (ace.sid == sid) return true;
  return false;
}

struct AclObjectShape {
  bool daclNull;
  bool daclProtected;
  bool labelProtected;
  bool reparse;
  std::vector<AclAce> dacl;
  std::vector<AclAce> label;
};
// A descriptor that only inherits is a function of its parents: restoring the root restores it.
// Anything else (an explicit or protected entry, or a link) is recorded in full. A file with more
// than one hard link has one descriptor for all its names, so propagation also reaches the names
// outside the root; package managers link most dependency files this way, so such files are not
// recorded individually.
inline bool aclInheritOnly(const AclObjectShape& shape) {
  if (shape.daclNull || shape.daclProtected || shape.labelProtected || shape.reparse) return false;
  for (const auto& ace : shape.dacl)
    if (aclExplicit(ace)) return false;
  for (const auto& ace : shape.label)
    if (aclExplicit(ace)) return false;
  return true;
}

struct AclLinkDecision {
  bool traverse;
  bool record;
  bool refuse;
};
// Name surrogates (junctions, symbolic links and similar) are never followed. A junction or
// symbolic link whose target stays inside the root is kept as a recorded object; any other name
// surrogate is refused, because propagation could otherwise reach objects outside the root. Other
// reparse points (such as cloud placeholders) are real files and directories.
inline AclLinkDecision aclLinkDecision(bool directory, bool reparse, std::uint32_t tag, bool targetInside) {
  if (!reparse) return {directory, false, false};
  if (tag & kAclNameSurrogate) {
    if ((tag == kAclTagSymlink || tag == kAclTagMountPoint) && targetInside) return {false, true, false};
    return {false, false, true};
  }
  return {directory, true, false};
}

inline bool aclDriveLetter(wchar_t c) { return (c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z'); }
// Resolves "." and ".." in a drive-absolute path ("C:\a\..\b" -> "C:\b") without touching the file
// system. Anything that is not a drive path, or that climbs above the drive root, is refused.
inline bool aclNormalizeDrivePath(const std::wstring& path, std::wstring& out) {
  if (path.size() < 3 || !aclDriveLetter(path[0]) || path[1] != L':' || (path[2] != L'\\' && path[2] != L'/'))
    return false;
  std::vector<std::wstring> parts;
  std::wstring part;
  for (std::size_t i = 3; i <= path.size(); ++i) {
    const wchar_t c = i < path.size() ? path[i] : L'\\';
    if (c != L'\\' && c != L'/') {
      part.push_back(c);
      continue;
    }
    if (part == L"..") {
      if (parts.empty()) return false;
      parts.pop_back();
    } else if (!part.empty() && part != L".") {
      parts.push_back(part);
    }
    part.clear();
  }
  out.assign(path, 0, 2);
  out.push_back(L'\\');
  for (std::size_t i = 0; i < parts.size(); ++i) {
    if (i) out.push_back(L'\\');
    out += parts[i];
  }
  return true;
}
// A stored link target: an absolute "\??\C:\..." name, or for a relative symbolic link a name
// relative to the directory holding the link (or to its drive root when it starts with "\").
inline bool aclLinkTargetPath(const std::wstring& linkDirectory, const std::wstring& target, bool relative,
                              std::wstring& out) {
  std::wstring absolute;
  if (relative) {
    if (linkDirectory.size() < 3) return false;
    absolute = !target.empty() && target[0] == L'\\' ? linkDirectory.substr(0, 2) + target : linkDirectory + L"\\" + target;
  } else {
    if (target.compare(0, 4, L"\\??\\") != 0) return false;
    absolute = target.substr(4);
  }
  return aclNormalizeDrivePath(absolute, out);
}
// Both paths are normalized; `equal` compares names the way the file system does.
template <typename Equal>
inline bool aclWithin(const std::wstring& root, const std::wstring& candidate, Equal equal) {
  if (candidate.size() < root.size() || !equal(root, candidate.substr(0, root.size()))) return false;
  return candidate.size() == root.size() || candidate[root.size()] == L'\\';
}

inline std::wstring aclHex(const std::uint8_t* bytes, std::size_t size) {
  static const wchar_t digits[] = L"0123456789abcdef";
  std::wstring out;
  for (std::size_t i = 0; i < size; ++i) {
    out.push_back(digits[bytes[i] >> 4]);
    out.push_back(digits[bytes[i] & 0x0f]);
  }
  return out;
}
inline std::wstring aclVolumeId(std::uint64_t serial) {
  std::uint8_t bytes[8];
  for (int i = 0; i < 8; ++i) bytes[i] = static_cast<std::uint8_t>(serial >> (8 * (7 - i)));
  return aclHex(bytes, sizeof(bytes));
}
// FILE_ID_128 is read as one little-endian number, so an NTFS file reference reads the same as
// the 64-bit index other APIs report.
inline std::wstring aclFileId(const std::uint8_t* identifier) {
  std::uint8_t bytes[16];
  for (int i = 0; i < 16; ++i) bytes[i] = identifier[15 - i];
  return aclHex(bytes, sizeof(bytes));
}
// Hashed as UTF-16LE. The identity is part of the fingerprint, so a fingerprint can only match
// the same object carrying the same descriptor.
inline std::wstring aclFingerprintText(const std::wstring& volumeId, const std::wstring& fileId,
                                       const std::wstring& descriptor) {
  return L"agnes-windows-acl-v1\n" + volumeId + L"\n" + fileId + L"\n" + descriptor;
}

// Local NTFS only: removable, fixed or RAM disk (GetDriveType 2, 3 and 6) with persistent ACLs.
inline bool aclVolumeSupported(const std::wstring& fileSystem, bool persistentAcls, unsigned driveType) {
  return fileSystem == L"NTFS" && persistentAcls && (driveType == 2 || driveType == 3 || driveType == 6);
}
