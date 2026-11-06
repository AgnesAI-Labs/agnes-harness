#pragma once
// Platform-neutral decisions for the Windows workspace write grant. The Windows caller reads real
// descriptors, reparse data and volume facts into these shapes; this header only decides, so the
// rules can be compiled and tested on any platform with synthetic entries.
//
// The grant shape (a capability allow entry, an Everyone delete-child deny and a Low no-write-up
// label) follows the write-restricted ACL backend of DeepSeek Harness
// (packages/sandbox/sandbox-windows-acl), MIT License, Copyright (c) 2026 DeepSeek; see
// DEEPSEEK-LICENSE.txt in this directory.
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

constexpr std::uint8_t kAclAllowType = 0x00;
constexpr std::uint8_t kAclDenyType = 0x01;
constexpr std::uint8_t kAclLabelType = 0x11;
constexpr std::uint8_t kAclObjectInherit = 0x01;
constexpr std::uint8_t kAclContainerInherit = 0x02;
constexpr std::uint8_t kAclNoPropagate = 0x04;
constexpr std::uint8_t kAclInheritOnly = 0x08;
constexpr std::uint8_t kAclInherited = 0x10;
// Write data, append, extended attributes, attributes, delete, delete child and synchronize.
// READ_CONTROL, WRITE_DAC and WRITE_OWNER stay out, so a confined child can neither rewrite an
// ACL nor take ownership to escape the grant.
constexpr std::uint32_t kAclGrantMask = 0x00110156;
constexpr std::uint32_t kAclDeleteChild = 0x00000040;
constexpr std::uint32_t kAclNoWriteUp = 0x00000001;
// Every right a write-restricted token's second check can be asked for on a file or directory:
// write data/add file, append/add subdirectory, extended attributes, delete child, attributes,
// delete, WRITE_DAC, WRITE_OWNER, GENERIC_ALL and GENERIC_WRITE.
constexpr std::uint32_t kAclWriteBits = 0x500D0156;
constexpr std::uint32_t kAclGenericRead = 0x80000000;
constexpr std::uint32_t kAclGenericWrite = 0x40000000;
constexpr std::uint32_t kAclGenericExecute = 0x20000000;
constexpr std::uint32_t kAclGenericAll = 0x10000000;
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

// The confined token's restricting list holds Everyone and the logon session's SID next to the
// write SIDs (see process-restricted.h), so an allow entry that gives either of them a write right
// passes its second access check, and the Low label a grant adds no longer stops it either. Such an
// object would be writable by every confined process on the machine, read-only ones included.
inline bool aclBroadPrincipal(const std::wstring& sid) {
  return sid == L"S-1-1-0" || sid.compare(0, 8, L"S-1-5-5-") == 0;
}
inline bool aclBroadWrite(const std::vector<AclAce>& dacl) {
  for (const auto& ace : dacl)
    if (ace.type == kAclAllowType && (ace.mask & kAclWriteBits) && aclBroadPrincipal(ace.sid)) return true;
  return false;
}

enum class AclPlanStatus { Ready, SidInUse, LabelConflict, BroadWrite };
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
  if (plan.status == AclPlanStatus::Ready && aclBroadWrite(dacl)) plan.status = AclPlanStatus::BroadWrite;
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

// File generic mapping (FILE_GENERIC_READ/WRITE/EXECUTE, FILE_ALL_ACCESS).
inline std::uint32_t aclMapGeneric(std::uint32_t mask) {
  std::uint32_t out = mask & ~(kAclGenericRead | kAclGenericWrite | kAclGenericExecute | kAclGenericAll);
  if (mask & kAclGenericRead) out |= 0x00120089;
  if (mask & kAclGenericWrite) out |= 0x00120116;
  if (mask & kAclGenericExecute) out |= 0x001200A0;
  if (mask & kAclGenericAll) out |= 0x001F01FF;
  return out;
}
// What an inherited entry means for one object: an entry that applies to the object itself
// (inherit == 0) or one it passes on to new children (the OI/CI/NP flags it passes them with).
// The system may store an inheritable entry with generic rights or CREATOR OWNER as one entry or
// split into an effective and an inherit-only copy; both read as the same parts here.
struct AclInheritedPart {
  std::uint8_t type;
  std::uint8_t inherit;
  std::uint32_t mask;
  std::wstring sid;
  bool operator<(const AclInheritedPart& other) const {
    if (type != other.type) return type < other.type;
    if (inherit != other.inherit) return inherit < other.inherit;
    if (mask != other.mask) return mask < other.mask;
    return sid < other.sid;
  }
  bool operator==(const AclInheritedPart& other) const {
    return type == other.type && inherit == other.inherit && mask == other.mask && sid == other.sid;
  }
};
inline bool aclModelled(const AclAce& ace) {
  return ace.type == kAclAllowType || ace.type == kAclDenyType || ace.type == kAclLabelType;
}
// A grant's own entries are rewritten by the grant's change itself (and an incomplete earlier
// propagation of them is what a repair finishes), so they never count as foreign inheritance.
inline bool aclGrantShape(const AclInheritedPart& part) {
  return (part.type == kAclAllowType && part.sid.compare(0, 6, L"S-1-4-") == 0) ||
         (part.type == kAclDenyType && part.sid == L"S-1-1-0" && part.mask == kAclDeleteChild) ||
         (part.type == kAclLabelType && part.sid == L"S-1-16-4096" && part.mask == kAclNoWriteUp);
}
inline void aclAddPart(std::vector<AclInheritedPart>& out, const AclInheritedPart& part) {
  if (!aclGrantShape(part)) out.push_back(part);
}
// Parts the entries a parent passes on produce on a child directory (`container`) or file. The
// effective copy maps generic rights and puts the child's owner or group in place of CREATOR OWNER
// (S-1-3-0) or CREATOR GROUP (S-1-3-1).
inline void aclPartsFromParent(const std::vector<AclAce>& parent, bool container, const std::wstring& owner,
                               const std::wstring& group, std::vector<AclInheritedPart>& out) {
  for (const auto& ace : parent) {
    if (!aclModelled(ace)) continue;
    const bool objects = (ace.flags & kAclObjectInherit) != 0, containers = (ace.flags & kAclContainerInherit) != 0;
    const bool propagate = (ace.flags & kAclNoPropagate) == 0;
    const std::wstring sid = ace.sid == L"S-1-3-0" ? owner : ace.sid == L"S-1-3-1" ? group : ace.sid;
    const std::uint32_t mask = aclMapGeneric(ace.mask);
    if (container ? containers : objects) aclAddPart(out, {ace.type, 0, mask, sid.empty() ? ace.sid : sid});
    if (container && propagate && (objects || containers))
      aclAddPart(out, {ace.type, static_cast<std::uint8_t>(ace.flags & (kAclObjectInherit | kAclContainerInherit)),
                       mask, ace.sid});
  }
}
// Parts the inherited entries an object carries now stand for. Explicit entries are its own.
inline void aclPartsInherited(const std::vector<AclAce>& list, std::vector<AclInheritedPart>& out) {
  for (const auto& ace : list) {
    if (aclExplicit(ace) || !aclModelled(ace)) continue;
    const std::uint32_t mask = aclMapGeneric(ace.mask);
    if (!(ace.flags & kAclInheritOnly)) aclAddPart(out, {ace.type, 0, mask, ace.sid});
    const auto inherit = static_cast<std::uint8_t>(ace.flags & (kAclObjectInherit | kAclContainerInherit | kAclNoPropagate));
    if (ace.flags & (kAclObjectInherit | kAclContainerInherit)) aclAddPart(out, {ace.type, inherit, mask, ace.sid});
  }
}
inline bool aclSameParts(std::vector<AclInheritedPart> left, std::vector<AclInheritedPart> right) {
  for (auto* list : {&left, &right}) {
    std::sort(list->begin(), list->end());
    list->erase(std::unique(list->begin(), list->end()), list->end());
  }
  return left == right;
}
// Whether an object's inherited entries are exactly what its current parent passes on. A folder
// moved within a volume keeps the entries it inherited at its old place; writing any descriptor
// above it makes the system recompute them from the new parent, which would silently and
// permanently replace them. A grant or repair refuses such a tree (E_ACL_STALE_INHERITANCE) before
// it changes anything. A protected DACL or label inherits nothing and is not compared; entry types
// other than allow, deny and mandatory label are not compared either.
inline bool aclInheritanceMatches(const std::vector<AclAce>& parentDacl, const std::vector<AclAce>& parentLabel,
                                  const std::vector<AclAce>& dacl, const std::vector<AclAce>& label,
                                  const std::wstring& owner, const std::wstring& group, bool container,
                                  bool daclProtected, bool labelProtected) {
  const auto matches = [&](const std::vector<AclAce>& from, const std::vector<AclAce>& now) {
    std::vector<AclInheritedPart> expected, actual;
    aclPartsFromParent(from, container, owner, group, expected);
    aclPartsInherited(now, actual);
    return aclSameParts(expected, actual);
  };
  return (daclProtected || matches(parentDacl, dacl)) && (labelProtected || matches(parentLabel, label));
}

// What a grant owns on its root, as hashed text: owner, group, protection and the explicit entries
// (as their stored bytes in hex). Inherited entries belong to the parents: a grant on an enclosing
// root changes them without touching anything this grant made.
inline std::wstring aclOwnedText(const std::wstring& volumeId, const std::wstring& fileId, const std::wstring& owner,
                                 const std::wstring& group, bool daclProtected, bool labelProtected,
                                 const std::vector<std::wstring>& dacl, const std::vector<std::wstring>& label) {
  const auto join = [](const std::vector<std::wstring>& list) {
    std::wstring out;
    for (std::size_t i = 0; i < list.size(); ++i) out += (i ? L"," : L"") + list[i];
    return out;
  };
  return L"agnes-windows-acl-owned-v1\n" + volumeId + L"\n" + fileId + L"\nO:" + owner + L"\nG:" + group + L"\nD:" +
         (daclProtected ? L"P:" : L"-:") + join(dacl) + L"\nS:" + (labelProtected ? L"P:" : L"-:") + join(label);
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

// A workspace root and its ancestors are held as real directories. A name surrogate there would
// redirect the path; any other reparse point (a cloud placeholder) is a real directory.
inline bool aclHoldableDirectory(bool reparse, std::uint32_t tag) { return !aclLinkDecision(true, reparse, tag, false).refuse; }

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
