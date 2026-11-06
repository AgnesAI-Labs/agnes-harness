// Windows workspace write grant: root identity, descriptor snapshots, and adding or removing the
// grant entries. Included by windows.cc after its shared helpers and canonical-fs-windows.h.
//
// Every write first proves that the root is the same object (volume and file ID read from a held
// handle) and that its descriptor and recorded descendants still match what the caller recorded.
// Afterwards the root and every object below it are read back. A failed system call is reported
// with its Win32 code and never counts as done. Policy decisions live in windows-acl-policy.h.
//
// The grant shape follows the write-restricted ACL backend of DeepSeek Harness
// (packages/sandbox/sandbox-windows-acl), MIT License, Copyright (c) 2026 DeepSeek; see
// DEEPSEEK-LICENSE.txt in this directory.
#include <functional>
#include <unordered_map>
#include <unordered_set>
#include "windows-acl-policy.h"

static const SECURITY_INFORMATION aclParts = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION |
                                             DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION;

struct AclRecord {
  AclAce ace;
  std::vector<BYTE> bytes;  // The entry exactly as stored, copied when an ACL is rebuilt.
};
struct AclSecurity {
  bool daclNull = true;
  bool daclProtected = false;
  bool labelProtected = false;
  BYTE daclRevision = ACL_REVISION;
  BYTE labelRevision = ACL_REVISION;
  std::vector<AclRecord> dacl, label;
  std::wstring sddl;
};
struct AclFacts {
  std::wstring path;  // Namespaced (\\?\) path the object was opened by.
  std::wstring volumeId, fileId;
  bool directory = false;
  bool reparse = false;
  DWORD tag = 0;
  AclSecurity security;
};
// A stable refusal code, or none for a Win32 failure that failure() maps to an errno-style code.
struct AclProblem {
  const char* code = nullptr;
  DWORD win32 = ERROR_SUCCESS;
  const char* what = "Windows ACL operation";
  std::wstring path, volumeId, fileId;
};

static AclProblem aclWin32Problem(DWORD error, const std::wstring& path, const char* what) {
  AclProblem problem;
  problem.win32 = error;
  problem.path = path;
  problem.what = what;
  return problem;
}
static AclProblem aclRefusal(const char* code, const std::wstring& path, const char* what) {
  AclProblem problem;
  problem.code = code;
  problem.path = path;
  problem.what = what;
  return problem;
}
static AclProblem aclObjectProblem(const char* code, const AclFacts& facts, const char* what, DWORD error = 0) {
  AclProblem problem = aclRefusal(code, facts.path, what);
  problem.win32 = error;
  problem.volumeId = facts.volumeId;
  problem.fileId = facts.fileId;
  return problem;
}
static napi_value aclThrow(napi_env env, const AclProblem& problem) {
  napi_value error = nullptr, value = nullptr;
  if (problem.code) {
    napi_value code = nullptr, message = nullptr;
    const std::string text = std::string(problem.code) + ": " + problem.what;
    napi_create_string_utf8(env, problem.code, NAPI_AUTO_LENGTH, &code);
    napi_create_string_utf8(env, text.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, code, message, &error);
    if (problem.win32) {
      napi_create_uint32(env, problem.win32, &value);
      napi_set_named_property(env, error, "win32Code", value);
    }
  } else {
    failure(env, problem.what, problem.win32);
    if (napi_get_and_clear_last_exception(env, &error) != napi_ok) return nullptr;
  }
  if (!problem.path.empty())
    napi_set_named_property(env, error, "path", canonicalWindowsText(env, canonicalDisplayPath(problem.path)));
  napi_throw(env, error);
  return nullptr;
}
static napi_value aclInvalid(napi_env env, const char* message) {
  napi_throw_type_error(env, "EINVAL", message);
  return nullptr;
}

static std::vector<AclAce> aclEntries(const std::vector<AclRecord>& records) {
  std::vector<AclAce> out;
  out.reserve(records.size());
  for (const auto& record : records) out.push_back(record.ace);
  return out;
}
static std::vector<AclAce> aclAllEntries(const AclSecurity& security) {
  std::vector<AclAce> out = aclEntries(security.dacl);
  for (const auto& record : security.label) out.push_back(record.ace);
  return out;
}
static AclObjectShape aclShape(const AclFacts& facts) {
  return AclObjectShape{facts.security.daclNull, facts.security.daclProtected, facts.security.labelProtected,
                        facts.reparse, aclEntries(facts.security.dacl), aclEntries(facts.security.label)};
}
static bool aclSameBytes(const std::vector<AclRecord>& left, const std::vector<AclRecord>& right) {
  if (left.size() != right.size()) return false;
  for (size_t i = 0; i < left.size(); ++i)
    if (left[i].bytes != right[i].bytes) return false;
  return true;
}

// Allowed, denied and mandatory-label entries share one layout: header, mask, then the SID.
static DWORD aclReadAces(PACL acl, std::vector<AclRecord>& out) {
  out.clear();
  if (!acl) return ERROR_SUCCESS;
  for (DWORD i = 0; i < acl->AceCount; ++i) {
    void* raw = nullptr;
    if (!GetAce(acl, i, &raw)) return GetLastError();
    const auto* header = static_cast<const ACE_HEADER*>(raw);
    const auto* bytes = static_cast<const BYTE*>(raw);
    const size_t size = header->AceSize;
    AclRecord record;
    record.bytes.assign(bytes, bytes + size);
    record.ace.type = header->AceType;
    record.ace.flags = header->AceFlags;
    record.ace.mask = 0;
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE || header->AceType == ACCESS_DENIED_ACE_TYPE ||
        header->AceType == SYSTEM_MANDATORY_LABEL_ACE_TYPE) {
      const size_t sidOffset = offsetof(ACCESS_ALLOWED_ACE, SidStart);
      // A SID is 8 bytes plus 4 per sub-authority; check its stated size fits inside the entry.
      if (size < sidOffset + 8 || sidOffset + 8 + 4u * bytes[sidOffset + 1] > size)
        return ERROR_INVALID_ACL;
      PSID sid = const_cast<BYTE*>(bytes + sidOffset);
      if (!IsValidSid(sid)) return ERROR_INVALID_SID;
      record.ace.mask = static_cast<const ACCESS_ALLOWED_ACE*>(raw)->Mask;
      LPWSTR text = nullptr;
      if (!ConvertSidToStringSidW(sid, &text)) return GetLastError();
      Local owned(text);
      record.ace.sid = text;
    }
    out.push_back(std::move(record));
  }
  return ERROR_SUCCESS;
}

static DWORD aclReadSecurity(HANDLE handle, AclSecurity& out) {
  PSECURITY_DESCRIPTOR raw = nullptr;
  const DWORD status = GetSecurityInfo(handle, SE_FILE_OBJECT, aclParts, nullptr, nullptr, nullptr, nullptr, &raw);
  if (status != ERROR_SUCCESS) return status;
  Local descriptor(raw);
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  BOOL daclPresent = FALSE, labelPresent = FALSE, defaulted = FALSE;
  PACL dacl = nullptr, label = nullptr;
  if (!GetSecurityDescriptorControl(raw, &control, &revision) ||
      !GetSecurityDescriptorDacl(raw, &daclPresent, &dacl, &defaulted) ||
      !GetSecurityDescriptorSacl(raw, &labelPresent, &label, &defaulted))
    return GetLastError();
  if (!daclPresent) dacl = nullptr;
  if (!labelPresent) label = nullptr;
  // A missing DACL and a NULL DACL both grant everyone everything; an empty DACL grants nothing.
  out.daclNull = dacl == nullptr;
  out.daclProtected = (control & SE_DACL_PROTECTED) != 0;
  out.labelProtected = (control & SE_SACL_PROTECTED) != 0;
  out.daclRevision = dacl ? dacl->AclRevision : static_cast<BYTE>(ACL_REVISION);
  out.labelRevision = label ? label->AclRevision : static_cast<BYTE>(ACL_REVISION);
  DWORD error = aclReadAces(dacl, out.dacl);
  if (error == ERROR_SUCCESS) error = aclReadAces(label, out.label);
  if (error != ERROR_SUCCESS) return error;
  LPWSTR text = nullptr;
  if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(raw, SDDL_REVISION_1, aclParts, &text, nullptr))
    return GetLastError();
  Local owned(text);
  out.sddl = text;
  return ERROR_SUCCESS;
}

static DWORD aclReadFacts(HANDLE handle, const std::wstring& path, AclFacts& facts) {
  facts.path = path;
  BY_HANDLE_FILE_INFORMATION information = {};
  FILE_ATTRIBUTE_TAG_INFO tag = {};
  FILE_ID_INFO identity = {};
  if (!GetFileInformationByHandle(handle, &information) ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &identity, sizeof(identity)))
    return GetLastError();
  facts.directory = (information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  facts.reparse = (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  facts.tag = facts.reparse ? tag.ReparseTag : 0;
  facts.volumeId = aclVolumeId(identity.VolumeSerialNumber);
  facts.fileId = aclFileId(identity.FileId.Identifier);
  return aclReadSecurity(handle, facts.security);
}

class AclHasher {
 public:
  AclHasher() = default;
  AclHasher(const AclHasher&) = delete;
  AclHasher& operator=(const AclHasher&) = delete;
  ~AclHasher() {
    if (algorithm_) BCryptCloseAlgorithmProvider(algorithm_, 0);
  }
  DWORD open() {
    const NTSTATUS status = BCryptOpenAlgorithmProvider(&algorithm_, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
    if (status >= 0) return ERROR_SUCCESS;
    algorithm_ = nullptr;
    return static_cast<DWORD>(status);
  }
  // SHA-256 of the UTF-16LE fingerprint text; see aclFingerprintText.
  DWORD fingerprint(const AclFacts& facts, std::wstring& out) const {
    const std::wstring text = aclFingerprintText(facts.volumeId, facts.fileId, facts.security.sddl);
    BCRYPT_HASH_HANDLE raw = nullptr;
    NTSTATUS status = BCryptCreateHash(algorithm_, &raw, nullptr, 0, nullptr, 0, 0);
    if (status < 0) return static_cast<DWORD>(status);
    std::unique_ptr<void, BCryptHashRelease> hash(raw);
    BYTE digest[32];
    status = BCryptHashData(raw, reinterpret_cast<PUCHAR>(const_cast<wchar_t*>(text.data())),
                            static_cast<ULONG>(text.size() * sizeof(wchar_t)), 0);
    if (status >= 0) status = BCryptFinishHash(raw, digest, sizeof(digest), 0);
    if (status < 0) return static_cast<DWORD>(status);
    out = aclHex(digest, sizeof(digest));
    return ERROR_SUCCESS;
  }

 private:
  BCRYPT_ALG_HANDLE algorithm_ = nullptr;
};

static DWORD aclFinalPath(HANDLE handle, std::wstring& path) {
  const DWORD required = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!required) return GetLastError();
  path.assign(required, L'\0');
  const DWORD written = GetFinalPathNameByHandleW(handle, &path[0], required, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!written) return GetLastError();
  if (written >= required) return ERROR_INVALID_DATA;
  path.resize(written);
  return ERROR_SUCCESS;
}
static bool aclDrivePath(const std::wstring& path) {
  return path.size() >= 7 && path.compare(0, 4, L"\\\\?\\") == 0 && aclDriveLetter(path[4]) && path[5] == L':' &&
         path[6] == L'\\';
}

struct AclRoot {
  std::vector<std::unique_ptr<Handle>> held;  // Ancestors, held so no path component can be swapped.
  std::unique_ptr<Handle> handle;
  std::wstring path;     // Final namespaced path; objects below are opened beneath it.
  std::wstring display;  // Normalized drive path, for link containment.
  AclFacts facts;
};

// Opens a workspace root by identity-bearing handle. Every ancestor is held without
// FILE_SHARE_DELETE, so neither the root nor a parent can be renamed or replaced while the
// operation runs, and none of them may be a reparse point.
static bool aclOpenRoot(const std::wstring& input, bool mutate, AclRoot& root, AclProblem& problem) {
  if (input.size() == 7 && aclDrivePath(input)) {
    problem = aclRefusal("E_ACL_DRIVE_ROOT", input, "a drive root cannot carry a workspace grant");
    return false;
  }
  bool canonical = input.size() > 7 && aclDrivePath(input) && input.back() != L'\\';
  for (size_t start = 7; canonical && start < input.size();) {
    size_t end = input.find(L'\\', start);
    if (end == std::wstring::npos) end = input.size();
    const std::wstring part = input.substr(start, end - start);
    canonical = !part.empty() && part != L"." && part != L"..";
    start = end + 1;
  }
  if (!canonical) {
    problem = aclRefusal("EINVAL", input, "expected a normalized \\\\?\\ drive path");
    return false;
  }
  for (size_t end = 6; end < input.size(); ++end) {
    if (input[end] != L'\\') continue;
    const std::wstring prefix = input.substr(0, end == 6 ? 7 : end);
    auto ancestor = std::make_unique<Handle>(CreateFileW(prefix.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    BY_HANDLE_FILE_INFORMATION information = {};
    if (ancestor->value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(ancestor->value, &information)) {
      problem = aclWin32Problem(GetLastError(), prefix, "open workspace ancestor");
      return false;
    }
    if (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
      problem = aclRefusal("E_ACL_REPARSE", prefix, "a workspace ancestor is a link or reparse point");
      return false;
    }
    if (!(information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
      problem = aclWin32Problem(ERROR_DIRECTORY, prefix, "open workspace ancestor");
      return false;
    }
    root.held.push_back(std::move(ancestor));
  }
  const DWORD access = READ_CONTROL | FILE_READ_ATTRIBUTES | (mutate ? WRITE_DAC | WRITE_OWNER : 0);
  root.handle = std::make_unique<Handle>(CreateFileW(input.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  BY_HANDLE_FILE_INFORMATION information = {};
  if (root.handle->value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(root.handle->value, &information)) {
    problem = aclWin32Problem(GetLastError(), input, "open workspace root");
    return false;
  }
  if (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    problem = aclRefusal("E_ACL_REPARSE", input, "the workspace root is a link or reparse point");
    return false;
  }
  if (!(information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
    problem = aclWin32Problem(ERROR_DIRECTORY, input, "open workspace root");
    return false;
  }
  // Check the volume before asking for anything only NTFS answers, such as the 128-bit file ID.
  wchar_t fileSystem[MAX_PATH + 1] = {};
  DWORD flags = 0;
  if (!GetVolumeInformationByHandleW(root.handle->value, nullptr, 0, nullptr, nullptr, &flags, fileSystem,
                                     MAX_PATH + 1)) {
    problem = aclWin32Problem(GetLastError(), input, "read workspace volume");
    return false;
  }
  std::wstring final;
  DWORD error = aclFinalPath(root.handle->value, final);
  if (error != ERROR_SUCCESS) {
    problem = aclWin32Problem(error, input, "resolve workspace root");
    return false;
  }
  if (final.size() == 7 && aclDrivePath(final)) {
    problem = aclRefusal("E_ACL_DRIVE_ROOT", input, "a drive root cannot carry a workspace grant");
    return false;
  }
  const wchar_t drive[] = {final.size() > 7 ? final[4] : L'?', L':', L'\\', L'\0'};
  if (!aclDrivePath(final) || final.size() <= 7 ||
      !aclVolumeSupported(fileSystem, (flags & FILE_PERSISTENT_ACLS) != 0, GetDriveTypeW(drive)) ||
      !aclNormalizeDrivePath(canonicalDisplayPath(final), root.display)) {
    problem = aclRefusal("E_ACL_UNSUPPORTED_VOLUME", input, "only local NTFS volumes can carry a workspace grant");
    return false;
  }
  root.path = final;
  error = aclReadFacts(root.handle->value, root.path, root.facts);
  if (error != ERROR_SUCCESS) {
    problem = aclWin32Problem(error, input, "read workspace root security");
    return false;
  }
  if (root.facts.security.daclNull) {
    problem = aclObjectProblem("E_ACL_NULL_DACL", root.facts, "the workspace root has no access control list");
    return false;
  }
  return true;
}

// Serializes grant changes to one root object across processes in this logon session. A holder
// that died leaves the mutex abandoned; the next owner proceeds, because every change first
// compares the current descriptor with the recorded one.
class AclLock {
 public:
  AclLock() = default;
  AclLock(const AclLock&) = delete;
  AclLock& operator=(const AclLock&) = delete;
  ~AclLock() {
    if (!mutex) return;
    ReleaseMutex(mutex);
    CloseHandle(mutex);
  }
  HANDLE mutex = nullptr;
};
static bool aclAcquire(const AclFacts& root, AclLock& lock, AclProblem& problem) {
  const std::wstring name = L"Local\\agnes-windows-acl-v1-" + root.volumeId + L"-" + root.fileId;
  HANDLE mutex = CreateMutexW(nullptr, FALSE, name.c_str());
  if (!mutex) {
    problem = aclWin32Problem(GetLastError(), root.path, "create workspace grant lock");
    return false;
  }
  const DWORD state = WaitForSingleObject(mutex, 0);
  if (state == WAIT_OBJECT_0 || state == WAIT_ABANDONED) {
    lock.mutex = mutex;
    return true;
  }
  const DWORD error = state == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
  CloseHandle(mutex);
  problem = state == WAIT_TIMEOUT ? aclRefusal("E_ACL_BUSY", root.path, "another workspace grant change is running")
                                  : aclWin32Problem(error, root.path, "acquire workspace grant lock");
  return false;
}

// Whether a junction or symbolic link leads somewhere inside the root. A live link is judged by the
// final path of what it reaches, so short names and chained links cannot hide where it goes; a
// dangling one by its stored target.
static DWORD aclLinkInside(HANDLE handle, const std::wstring& path, const std::wstring& rootDisplay, bool& inside) {
  inside = false;
  Handle reached(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (reached.value != INVALID_HANDLE_VALUE) {
    std::wstring final, resolved;
    const DWORD error = aclFinalPath(reached.value, final);
    if (error != ERROR_SUCCESS) return error;
    inside = aclNormalizeDrivePath(canonicalDisplayPath(final), resolved) && aclWithin(rootDisplay, resolved, windowsPathEqual);
    return ERROR_SUCCESS;
  }
  const DWORD opened = GetLastError();
  if (opened != ERROR_FILE_NOT_FOUND && opened != ERROR_PATH_NOT_FOUND) return opened;
  std::vector<BYTE> bytes(MAXIMUM_REPARSE_DATA_BUFFER_SIZE);
  DWORD count = 0;
  if (!DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, nullptr, 0, bytes.data(), static_cast<DWORD>(bytes.size()),
                       &count, nullptr))
    return GetLastError();
  if (count < 16) return ERROR_INVALID_DATA;
  DWORD tag = 0;
  USHORT offset = 0, length = 0;
  ULONG flags = 0;
  size_t start = 0;
  memcpy(&tag, bytes.data(), sizeof(tag));
  memcpy(&offset, bytes.data() + 8, sizeof(offset));
  memcpy(&length, bytes.data() + 10, sizeof(length));
  if (tag == IO_REPARSE_TAG_SYMLINK) {
    if (count < 20) return ERROR_INVALID_DATA;
    memcpy(&flags, bytes.data() + 16, sizeof(flags));
    start = 20;
  } else if (tag == IO_REPARSE_TAG_MOUNT_POINT) {
    start = 16;
  } else {
    return ERROR_SUCCESS;
  }
  if ((offset % 2) || (length % 2) || start + offset + length > count) return ERROR_INVALID_DATA;
  std::wstring stored(length / sizeof(wchar_t), L'\0');
  if (length) memcpy(&stored[0], bytes.data() + start + offset, length);
  const std::wstring display = canonicalDisplayPath(path);
  const size_t slash = display.find_last_of(L'\\');
  std::wstring resolved;
  if (slash == std::wstring::npos ||
      !aclLinkTargetPath(display.substr(0, slash), stored, (flags & kAclSymlinkRelative) != 0, resolved))
    return ERROR_SUCCESS;
  inside = aclWithin(rootDisplay, resolved, windowsPathEqual);
  return ERROR_SUCCESS;
}

struct AclFrame {
  std::unique_ptr<Handle> directory;  // Null for the root, which the caller holds.
  std::unique_ptr<CanonicalSearch> search;
  std::wstring path;
  bool inheritsDacl = true;
  bool inheritsLabel = true;
  bool pending = false;
  WIN32_FIND_DATAW entry = {};
};
struct AclWalk {
  bool rights = false;    // Also demand the rights a propagated change needs on every object.
  bool tolerate = false;  // After a write: record each problem and keep going.
  // Gets every object below the root with whether its DACL and label still inherit from the
  // root. Returning false stops a strict walk with the problem it filled in.
  std::function<bool(const AclFacts&, bool, bool, AclProblem&)> visit;
  std::vector<AclProblem> problems;
};
static DWORD aclStartSearch(AclFrame& frame) {
  HANDLE search = FindFirstFileExW((frame.path + L"\\*").c_str(), FindExInfoBasic, &frame.entry,
                                   FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH);
  if (search == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    frame.pending = false;
    return error == ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : error;
  }
  frame.search = std::make_unique<CanonicalSearch>(search);
  frame.pending = true;
  return ERROR_SUCCESS;
}
static bool aclKeepGoing(AclWalk& walk, const AclProblem& found, AclProblem& problem) {
  if (!walk.tolerate) {
    problem = found;
    return false;
  }
  walk.problems.push_back(found);
  return true;
}

// Depth-first walk below the root that never follows a link. Each directory being listed, and
// every directory above it, is held without FILE_SHARE_DELETE, so the listing by path cannot be
// redirected elsewhere. An object removed meanwhile is skipped.
static bool aclWalk(const AclRoot& root, AclWalk& walk, AclProblem& problem) {
  std::vector<AclFrame> frames(1);
  frames[0].path = root.path;
  DWORD error = aclStartSearch(frames[0]);
  if (error != ERROR_SUCCESS) return aclKeepGoing(walk, aclWin32Problem(error, root.path, "list workspace"), problem);
  while (!frames.empty()) {
    if (!frames.back().pending) {
      frames.pop_back();
      continue;
    }
    const WIN32_FIND_DATAW entry = frames.back().entry;
    const std::wstring parent = frames.back().path;
    const bool parentDacl = frames.back().inheritsDacl, parentLabel = frames.back().inheritsLabel;
    if (!FindNextFileW(frames.back().search->value, &frames.back().entry)) {
      error = GetLastError();
      frames.back().pending = false;
      if (error != ERROR_NO_MORE_FILES &&
          !aclKeepGoing(walk, aclWin32Problem(error, parent, "list workspace directory"), problem))
        return false;
    }
    if (!wcscmp(entry.cFileName, L".") || !wcscmp(entry.cFileName, L"..")) continue;
    const std::wstring path = parent + L"\\" + entry.cFileName;
    const bool listedLink = (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && (entry.dwReserved0 & kAclNameSurrogate);
    const bool hold = (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !listedLink;
    const DWORD access = READ_CONTROL | FILE_READ_ATTRIBUTES | (walk.rights ? WRITE_DAC | WRITE_OWNER : 0);
    auto handle = std::make_unique<Handle>(CreateFileW(path.c_str(), access,
      FILE_SHARE_READ | FILE_SHARE_WRITE | (hold ? 0 : FILE_SHARE_DELETE), nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (handle->value == INVALID_HANDLE_VALUE) {
      error = GetLastError();
      if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) continue;
      if (!aclKeepGoing(walk, aclWin32Problem(error, path, "open workspace object"), problem)) return false;
      continue;
    }
    AclFacts facts;
    error = aclReadFacts(handle->value, path, facts);
    if (error != ERROR_SUCCESS) {
      if (!aclKeepGoing(walk, aclWin32Problem(error, path, "read workspace object security"), problem)) return false;
      continue;
    }
    if (facts.security.daclNull) {
      if (!aclKeepGoing(walk, aclObjectProblem("E_ACL_NULL_DACL", facts, "an object has no access control list"), problem))
        return false;
      continue;
    }
    bool inside = false;
    if (facts.reparse && (facts.tag & kAclNameSurrogate)) {
      error = aclLinkInside(handle->value, path, root.display, inside);
      if (error != ERROR_SUCCESS) {
        if (!aclKeepGoing(walk, aclWin32Problem(error, path, "read workspace link"), problem)) return false;
        continue;
      }
    }
    const AclLinkDecision link = aclLinkDecision(facts.directory, facts.reparse, facts.tag, inside);
    if (link.refuse) {
      if (!aclKeepGoing(walk, aclObjectProblem("E_ACL_REPARSE", facts, "a link leads outside the workspace"), problem))
        return false;
      continue;
    }
    if (link.traverse && !hold) {
      // The listing and the opened object disagree: it was replaced in between.
      if (!aclKeepGoing(walk, aclObjectProblem("E_ACL_CHANGED", facts, "an object changed while it was read"), problem))
        return false;
      continue;
    }
    const bool inheritsDacl = parentDacl && !facts.security.daclProtected;
    const bool inheritsLabel = parentLabel && !facts.security.labelProtected;
    if (!walk.visit(facts, inheritsDacl, inheritsLabel, problem)) return false;
    if (!link.traverse) continue;
    if (frames.size() >= 4096) {
      if (!aclKeepGoing(walk, aclObjectProblem("E_ACL_TOO_LARGE", facts, "the workspace is nested too deeply"), problem))
        return false;
      continue;
    }
    AclFrame child;
    child.directory = std::move(handle);
    child.path = path;
    child.inheritsDacl = inheritsDacl;
    child.inheritsLabel = inheritsLabel;
    error = aclStartSearch(child);
    if (error != ERROR_SUCCESS) {
      if (!aclKeepGoing(walk, aclWin32Problem(error, path, "list workspace directory"), problem)) return false;
      continue;
    }
    frames.push_back(std::move(child));
  }
  return true;
}

static napi_value aclObjectValue(napi_env env, const std::wstring& path, const std::wstring& volumeId,
                                 const std::wstring& fileId, const std::wstring& sddl, const std::wstring& print) {
  napi_value object = nullptr;
  napi_create_object(env, &object);
  napi_set_named_property(env, object, "path", canonicalWindowsText(env, canonicalDisplayPath(path)));
  napi_set_named_property(env, object, "volumeId", canonicalWindowsText(env, volumeId));
  napi_set_named_property(env, object, "fileId", canonicalWindowsText(env, fileId));
  napi_set_named_property(env, object, "securityDescriptor", canonicalWindowsText(env, sddl));
  napi_set_named_property(env, object, "fingerprint", canonicalWindowsText(env, print));
  return object;
}

/** Root identity and descriptor plus every object below it that inheritance alone does not determine. */
static napi_value aclInspect(napi_env env, napi_callback_info info) {
  napi_value args[1];
  std::wstring input;
  if (!arguments(env, info, 1, args) || !stringArgument(env, args[0], input)) return nullptr;
  AclProblem problem;
  AclRoot root;
  if (!aclOpenRoot(input, false, root, problem)) return aclThrow(env, problem);
  AclHasher hasher;
  std::wstring rootPrint;
  DWORD error = hasher.open();
  if (error == ERROR_SUCCESS) error = hasher.fingerprint(root.facts, rootPrint);
  if (error != ERROR_SUCCESS) return aclThrow(env, aclWin32Problem(error, root.path, "fingerprint workspace root"));
  struct Recorded {
    std::wstring path, volumeId, fileId, sddl, print;
  };
  std::vector<Recorded> recorded;
  std::unordered_set<std::wstring> seen;
  double inherited = 0;
  AclWalk walk;
  walk.visit = [&](const AclFacts& facts, bool, bool, AclProblem& found) {
    if (aclInheritOnly(aclShape(facts))) {
      inherited += 1;
      return true;
    }
    // An object reached through several hard links in the tree is kept once.
    if (!seen.insert(facts.volumeId + L":" + facts.fileId).second) return true;
    if (recorded.size() >= kAclMaxRecorded) {
      found = aclObjectProblem("E_ACL_TOO_LARGE", facts, "too many objects carry their own permissions");
      return false;
    }
    std::wstring print;
    const DWORD hashed = hasher.fingerprint(facts, print);
    if (hashed != ERROR_SUCCESS) {
      found = aclWin32Problem(hashed, facts.path, "fingerprint workspace object");
      return false;
    }
    recorded.push_back({facts.path, facts.volumeId, facts.fileId, facts.security.sddl, print});
    return true;
  };
  if (!aclWalk(root, walk, problem)) return aclThrow(env, problem);
  napi_value result = aclObjectValue(env, root.path, root.facts.volumeId, root.facts.fileId, root.facts.security.sddl,
                                     rootPrint);
  napi_value descendants = nullptr, count = nullptr;
  napi_create_array_with_length(env, recorded.size(), &descendants);
  for (size_t i = 0; i < recorded.size(); ++i) {
    const Recorded& item = recorded[i];
    napi_set_element(env, descendants, static_cast<uint32_t>(i),
                     aclObjectValue(env, item.path, item.volumeId, item.fileId, item.sddl, item.print));
  }
  napi_set_named_property(env, result, "descendants", descendants);
  napi_create_double(env, inherited, &count);
  napi_set_named_property(env, result, "inheritedDescendants", count);
  return result;
}

/** Root identity alone: the same checks as opening the root for inspection, without the walk. */
static napi_value aclIdentity(napi_env env, napi_callback_info info) {
  napi_value args[1];
  std::wstring input;
  if (!arguments(env, info, 1, args) || !stringArgument(env, args[0], input)) return nullptr;
  AclProblem problem;
  AclRoot root;
  if (!aclOpenRoot(input, false, root, problem)) return aclThrow(env, problem);
  napi_value result = nullptr;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "volumeId", canonicalWindowsText(env, root.facts.volumeId));
  napi_set_named_property(env, result, "fileId", canonicalWindowsText(env, root.facts.fileId));
  return result;
}

// Adding and removing the grant entries.

struct AclBefore {
  std::wstring print;
  std::vector<AclAce> entries;  // DACL entries followed by label entries.
};
struct AclChange {
  std::wstring path, volumeId, fileId, before, after;
  std::vector<AclAce> added, removed;
};
struct AclOutcome {
  std::vector<AclChange> changes;
  std::vector<AclProblem> failures;
  std::unordered_set<std::wstring> reported;
  double inherited = 0;
};
struct AclWritePlan {
  std::vector<AclRecord> dacl, label;
  bool writeLabel = false;
  std::wstring grantSid;    // Apply: every object that still inherits must now carry this grant.
  std::wstring removedSid;  // Restore: no object may still name this SID.
};

static bool aclOptionalText(napi_env env, napi_value value, std::wstring& out) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > 256) {
    napi_throw_type_error(env, "EINVAL", "Expected a SID string");
    return false;
  }
  out.resize(length + 1);
  if (napi_get_value_string_utf16(env, value, reinterpret_cast<char16_t*>(&out[0]), length + 1, &length) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "Cannot read SID string");
    return false;
  }
  out.resize(length);
  return true;
}
// Recorded descendants as "volumeId:fileId:fingerprint", keyed by identity.
static bool aclExpectedObjects(napi_env env, napi_value array, std::unordered_map<std::wstring, std::wstring>& out) {
  bool isArray = false;
  uint32_t length = 0;
  if (napi_is_array(env, array, &isArray) != napi_ok || !isArray || napi_get_array_length(env, array, &length) != napi_ok ||
      length > kAclMaxRecorded) {
    napi_throw_type_error(env, "EINVAL", "Expected recorded Windows ACL descendants");
    return false;
  }
  for (uint32_t i = 0; i < length; ++i) {
    napi_value item = nullptr;
    std::wstring text;
    if (napi_get_element(env, array, i, &item) != napi_ok || !stringArgument(env, item, text)) return false;
    if (text.size() != 16 + 1 + 32 + 1 + 64 || text[16] != L':' || text[49] != L':') {
      napi_throw_type_error(env, "EINVAL", "Invalid recorded Windows ACL descendant");
      return false;
    }
    out[text.substr(0, 49)] = text.substr(50);
  }
  return true;
}

// Only a canonical S-1-4-... capability SID: never an account, group or well-known principal.
static bool aclCapabilitySid(const std::wstring& text, std::vector<BYTE>& sid) {
  PSID raw = nullptr;
  if (!ConvertStringSidToSidW(text.c_str(), &raw)) return false;
  Local owned(raw);
  static const BYTE nonUnique[6] = {0, 0, 0, 0, 0, 4};
  const SID_IDENTIFIER_AUTHORITY* authority = IsValidSid(raw) ? GetSidIdentifierAuthority(raw) : nullptr;
  if (!authority || memcmp(authority->Value, nonUnique, sizeof(nonUnique)) != 0 || *GetSidSubAuthorityCount(raw) < 1)
    return false;
  LPWSTR canonical = nullptr;
  if (!ConvertSidToStringSidW(raw, &canonical)) return false;
  Local canonicalOwned(canonical);
  if (text != canonical) return false;
  const auto* bytes = static_cast<const BYTE*>(raw);
  sid.assign(bytes, bytes + GetLengthSid(raw));
  return true;
}
static bool aclWellKnownSid(WELL_KNOWN_SID_TYPE type, std::vector<BYTE>& sid) {
  DWORD size = SECURITY_MAX_SID_SIZE;
  sid.assign(size, 0);
  if (!CreateWellKnownSid(type, nullptr, sid.data(), &size)) return false;
  sid.resize(size);
  return true;
}
// Lets the system encode one grant entry, so its bytes match what the system stores.
static DWORD aclEntryRecord(const AclAce& entry, std::vector<BYTE>& sid, AclRecord& out) {
  std::vector<DWORD> storage((sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) + sid.size()) / sizeof(DWORD) + 2);
  PACL acl = reinterpret_cast<PACL>(storage.data());
  if (!InitializeAcl(acl, static_cast<DWORD>(storage.size() * sizeof(DWORD)), ACL_REVISION)) return GetLastError();
  BOOL added = FALSE;
  if (entry.type == kAclAllowType)
    added = AddAccessAllowedAceEx(acl, ACL_REVISION, entry.flags, entry.mask, sid.data());
  else if (entry.type == kAclDenyType)
    added = AddAccessDeniedAceEx(acl, ACL_REVISION, entry.flags, entry.mask, sid.data());
  else
    added = AddMandatoryAce(acl, ACL_REVISION, entry.flags, entry.mask, sid.data());
  if (!added) return GetLastError();
  void* raw = nullptr;
  if (!GetAce(acl, 0, &raw)) return GetLastError();
  const auto* bytes = static_cast<const BYTE*>(raw);
  out.ace = entry;
  out.bytes.assign(bytes, bytes + static_cast<const ACE_HEADER*>(raw)->AceSize);
  return ERROR_SUCCESS;
}
// Lays the entries out verbatim in a new ACL. `fits` is false when they exceed the ACL size limit.
static DWORD aclBuild(BYTE revision, const std::vector<AclRecord>& records, std::vector<DWORD>& storage, bool& fits) {
  size_t size = sizeof(ACL);
  for (const auto& record : records) size += record.bytes.size();
  size = (size + sizeof(DWORD) - 1) / sizeof(DWORD) * sizeof(DWORD);
  fits = size <= 0xFFFC;
  if (!fits) return ERROR_SUCCESS;
  storage.assign(size / sizeof(DWORD), 0);
  PACL acl = reinterpret_cast<PACL>(storage.data());
  const DWORD aclRevision = static_cast<DWORD>(revision < ACL_REVISION ? ACL_REVISION : revision);
  if (!InitializeAcl(acl, static_cast<DWORD>(size), aclRevision)) return GetLastError();
  for (const auto& record : records)
    if (!AddAce(acl, aclRevision, MAXDWORD, const_cast<BYTE*>(record.bytes.data()),
                static_cast<DWORD>(record.bytes.size())))
      return GetLastError();
  return ERROR_SUCCESS;
}

// Locks the root and proves it is still the object and descriptor the caller recorded.
static bool aclBeginChange(const std::wstring& input, const std::wstring& volumeId, const std::wstring& fileId,
                           const std::wstring& expectedPrint, AclRoot& root, AclLock& lock, AclHasher& hasher,
                           std::wstring& rootPrint, AclProblem& problem) {
  if (!aclOpenRoot(input, true, root, problem)) return false;
  if (root.facts.volumeId != volumeId || root.facts.fileId != fileId) {
    problem = aclObjectProblem("E_ACL_IDENTITY_MISMATCH", root.facts, "the workspace root is a different directory");
    return false;
  }
  if (!aclAcquire(root.facts, lock, problem)) return false;
  // Read again under the lock, so a change finished before the lock was taken is seen.
  DWORD error = aclReadFacts(root.handle->value, root.path, root.facts);
  if (error == ERROR_SUCCESS) error = hasher.open();
  if (error == ERROR_SUCCESS) error = hasher.fingerprint(root.facts, rootPrint);
  if (error != ERROR_SUCCESS) {
    problem = aclWin32Problem(error, root.path, "read workspace root security");
    return false;
  }
  if (root.facts.security.daclNull) {
    problem = aclObjectProblem("E_ACL_NULL_DACL", root.facts, "the workspace root has no access control list");
    return false;
  }
  if (rootPrint != expectedPrint) {
    problem = aclObjectProblem("E_ACL_CHANGED", root.facts, "the workspace root permissions changed since they were recorded");
    return false;
  }
  return true;
}

// Before any write: every object must be readable and changeable, and every link must stay inside.
// Objects with their own permissions keep their state for the change report. When `expected` is
// given (a grant), each of them must be one the caller recorded, still unchanged.
static bool aclPrepare(const AclRoot& root, const AclHasher& hasher,
                       const std::unordered_map<std::wstring, std::wstring>* expected,
                       std::unordered_map<std::wstring, AclBefore>& before, AclProblem& problem) {
  AclWalk walk;
  walk.rights = true;
  walk.visit = [&](const AclFacts& facts, bool, bool, AclProblem& found) {
    const std::wstring key = facts.volumeId + L":" + facts.fileId;
    const std::wstring* wanted = nullptr;
    if (expected) {
      const auto match = expected->find(key);
      if (match != expected->end()) wanted = &match->second;
    }
    const bool plain = aclInheritOnly(aclShape(facts));
    if (plain && !wanted) return true;
    if (expected && !wanted) {
      found = aclObjectProblem("E_ACL_CHANGED", facts, "an object gained its own permissions since they were recorded");
      return false;
    }
    if (before.size() >= kAclMaxRecorded && !before.count(key)) {
      found = aclObjectProblem("E_ACL_TOO_LARGE", facts, "too many objects carry their own permissions");
      return false;
    }
    std::wstring print;
    const DWORD hashed = hasher.fingerprint(facts, print);
    if (hashed != ERROR_SUCCESS) {
      found = aclWin32Problem(hashed, facts.path, "fingerprint workspace object");
      return false;
    }
    if (wanted && print != *wanted) {
      found = aclObjectProblem("E_ACL_CHANGED", facts, "an object's permissions changed since they were recorded");
      return false;
    }
    before.emplace(key, AclBefore{print, aclAllEntries(facts.security)});
    return true;
  };
  return aclWalk(root, walk, problem);
}

static void aclRecordChange(AclOutcome& outcome, const AclFacts& facts, const std::wstring& beforePrint,
                            const std::wstring& afterPrint, const std::vector<AclAce>& prior,
                            const std::vector<AclAce>& now) {
  if (!outcome.reported.insert(facts.volumeId + L":" + facts.fileId).second) return;
  outcome.changes.push_back(
    {facts.path, facts.volumeId, facts.fileId, beforePrint, afterPrint, aclAdded(prior, now), aclAdded(now, prior)});
}

static void aclVerifyRoot(const AclRoot& root, const AclHasher& hasher, const std::wstring& rootPrint,
                          const AclWritePlan& plan, bool written, AclOutcome& outcome) {
  AclFacts after;
  std::wstring afterPrint;
  DWORD error = aclReadFacts(root.handle->value, root.path, after);
  if (error == ERROR_SUCCESS) error = hasher.fingerprint(after, afterPrint);
  if (error != ERROR_SUCCESS) {
    outcome.failures.push_back(aclObjectProblem("E_ACL_VERIFY_FAILED", root.facts, "read back workspace root", error));
    return;
  }
  const std::vector<AclRecord>& label = plan.writeLabel ? plan.label : root.facts.security.label;
  if (written && (!aclSameBytes(after.security.dacl, plan.dacl) || !aclSameBytes(after.security.label, label) ||
                  after.security.daclProtected != root.facts.security.daclProtected ||
                  after.security.labelProtected != root.facts.security.labelProtected))
    outcome.failures.push_back(
      aclObjectProblem("E_ACL_UNEXPECTED_RESULT", root.facts, "the workspace root does not read back as written"));
  if (afterPrint != rootPrint)
    aclRecordChange(outcome, root.facts, rootPrint, afterPrint, aclAllEntries(root.facts.security),
                    aclAllEntries(after.security));
}

// Reads back every object below the root after a write. Problems are recorded, never fatal: the
// caller needs the actual state, whatever it is.
static void aclVerifyTree(const AclRoot& root, const AclHasher& hasher, const AclWritePlan& plan,
                          const std::unordered_map<std::wstring, AclBefore>& before, AclOutcome& outcome) {
  AclWalk walk;
  walk.tolerate = true;
  walk.visit = [&](const AclFacts& facts, bool inheritsDacl, bool inheritsLabel, AclProblem&) {
    const std::vector<AclAce> dacl = aclEntries(facts.security.dacl), label = aclEntries(facts.security.label);
    bool sound = true;
    // A link object's own entries do not decide access to its target, which is checked itself.
    if (!plan.grantSid.empty() && !facts.reparse &&
        !aclCarriesGrant(dacl, label, plan.grantSid, facts.directory, inheritsDacl, inheritsLabel)) {
      outcome.failures.push_back(
        aclObjectProblem("E_ACL_PROPAGATION_INCOMPLETE", facts, "an object below the root lacks the grant"));
      sound = false;
    }
    if (!plan.removedSid.empty() && (aclNamesSid(dacl, plan.removedSid) || aclNamesSid(label, plan.removedSid))) {
      outcome.failures.push_back(
        aclObjectProblem("E_ACL_REMOVAL_INCOMPLETE", facts, "an object below the root still names the write SID"));
      sound = false;
    }
    const auto prior = before.find(facts.volumeId + L":" + facts.fileId);
    if (prior == before.end()) {
      if (sound && aclInheritOnly(aclShape(facts))) outcome.inherited += 1;
      return true;
    }
    std::wstring print;
    const DWORD hashed = hasher.fingerprint(facts, print);
    if (hashed != ERROR_SUCCESS) {
      outcome.failures.push_back(aclObjectProblem("E_ACL_VERIFY_FAILED", facts, "fingerprint workspace object", hashed));
      return true;
    }
    if (print != prior->second.print)
      aclRecordChange(outcome, facts, prior->second.print, print, prior->second.entries, aclAllEntries(facts.security));
    return true;
  };
  AclProblem ignored;
  aclWalk(root, walk, ignored);
  for (AclProblem found : walk.problems) {
    if (!found.code) found.code = "E_ACL_VERIFY_FAILED";
    outcome.failures.push_back(std::move(found));
  }
}

static napi_value aclEntriesValue(napi_env env, const std::vector<AclAce>& entries) {
  napi_value array = nullptr;
  napi_create_array_with_length(env, entries.size(), &array);
  for (size_t i = 0; i < entries.size(); ++i) {
    const AclAce& entry = entries[i];
    napi_value item = nullptr, mask = nullptr, flags = nullptr;
    napi_create_object(env, &item);
    canonicalWindowsString(env, item, "kind",
                           entry.type == kAclAllowType  ? "allow"
                           : entry.type == kAclDenyType ? "deny"
                           : entry.type == kAclLabelType ? "label"
                                                         : "other");
    napi_set_named_property(env, item, "sid", canonicalWindowsText(env, entry.sid));
    napi_create_uint32(env, entry.mask, &mask);
    napi_set_named_property(env, item, "mask", mask);
    napi_create_uint32(env, entry.flags, &flags);
    napi_set_named_property(env, item, "flags", flags);
    napi_set_element(env, array, static_cast<uint32_t>(i), item);
  }
  return array;
}
static napi_value aclOutcomeValue(napi_env env, const AclOutcome& outcome) {
  napi_value result = nullptr, changes = nullptr, failures = nullptr, value = nullptr;
  napi_create_object(env, &result);
  napi_get_boolean(env, outcome.failures.empty(), &value);
  napi_set_named_property(env, result, "complete", value);
  napi_create_array_with_length(env, outcome.changes.size(), &changes);
  for (size_t i = 0; i < outcome.changes.size(); ++i) {
    const AclChange& change = outcome.changes[i];
    napi_value item = nullptr;
    napi_create_object(env, &item);
    napi_set_named_property(env, item, "path", canonicalWindowsText(env, canonicalDisplayPath(change.path)));
    napi_set_named_property(env, item, "volumeId", canonicalWindowsText(env, change.volumeId));
    napi_set_named_property(env, item, "fileId", canonicalWindowsText(env, change.fileId));
    napi_set_named_property(env, item, "beforeFingerprint", canonicalWindowsText(env, change.before));
    napi_set_named_property(env, item, "afterFingerprint", canonicalWindowsText(env, change.after));
    napi_set_named_property(env, item, "added", aclEntriesValue(env, change.added));
    napi_set_named_property(env, item, "removed", aclEntriesValue(env, change.removed));
    napi_set_element(env, changes, static_cast<uint32_t>(i), item);
  }
  napi_set_named_property(env, result, "changes", changes);
  napi_create_array_with_length(env, outcome.failures.size(), &failures);
  for (size_t i = 0; i < outcome.failures.size(); ++i) {
    const AclProblem& found = outcome.failures[i];
    napi_value item = nullptr, code = nullptr;
    napi_create_object(env, &item);
    napi_set_named_property(env, item, "path", canonicalWindowsText(env, canonicalDisplayPath(found.path)));
    napi_set_named_property(env, item, "volumeId", canonicalWindowsText(env, found.volumeId));
    napi_set_named_property(env, item, "fileId", canonicalWindowsText(env, found.fileId));
    canonicalWindowsString(env, item, "code", found.code ? found.code : "E_ACL_VERIFY_FAILED");
    napi_create_uint32(env, found.win32, &code);
    napi_set_named_property(env, item, "win32Code", code);
    napi_set_element(env, failures, static_cast<uint32_t>(i), item);
  }
  napi_set_named_property(env, result, "failures", failures);
  napi_create_double(env, outcome.inherited, &value);
  napi_set_named_property(env, result, "inheritedDescendants", value);
  return result;
}

static napi_value aclWriteAndVerify(napi_env env, const AclRoot& root, const AclHasher& hasher,
                                    const std::wstring& rootPrint, const AclWritePlan& plan,
                                    const std::unordered_map<std::wstring, AclBefore>& before) {
  std::vector<DWORD> daclStorage, labelStorage;
  bool fits = true;
  DWORD error = aclBuild(root.facts.security.daclRevision, plan.dacl, daclStorage, fits);
  if (error == ERROR_SUCCESS && fits && plan.writeLabel)
    error = aclBuild(root.facts.security.labelRevision, plan.label, labelStorage, fits);
  if (!fits)
    return aclThrow(env, aclObjectProblem("E_ACL_TOO_LARGE", root.facts, "the access control list would exceed its size limit"));
  if (error != ERROR_SUCCESS) return aclThrow(env, aclWin32Problem(error, root.path, "build workspace access control list"));
  // One last look right before the write narrows the window for a change by another program.
  AclFacts current;
  std::wstring currentPrint;
  error = aclReadFacts(root.handle->value, root.path, current);
  if (error == ERROR_SUCCESS) error = hasher.fingerprint(current, currentPrint);
  if (error != ERROR_SUCCESS) return aclThrow(env, aclWin32Problem(error, root.path, "read workspace root security"));
  if (currentPrint != rootPrint)
    return aclThrow(env, aclObjectProblem("E_ACL_CHANGED", root.facts, "the workspace root permissions changed during preparation"));
  // Keep the root's own inheritance setting. The system propagates the new inheritable entries to
  // every existing object below the root within this call.
  const SECURITY_INFORMATION parts =
    DACL_SECURITY_INFORMATION | (plan.writeLabel ? LABEL_SECURITY_INFORMATION : 0) |
    (root.facts.security.daclProtected ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION);
  const DWORD written = SetSecurityInfo(root.handle->value, SE_FILE_OBJECT, parts, nullptr, nullptr,
                                        reinterpret_cast<PACL>(daclStorage.data()),
                                        plan.writeLabel ? reinterpret_cast<PACL>(labelStorage.data()) : nullptr);
  AclOutcome outcome;
  if (written != ERROR_SUCCESS)
    outcome.failures.push_back(aclObjectProblem("E_ACL_WRITE_FAILED", root.facts, "set workspace root security", written));
  aclVerifyRoot(root, hasher, rootPrint, plan, written == ERROR_SUCCESS, outcome);
  aclVerifyTree(root, hasher, plan, before, outcome);
  return aclOutcomeValue(env, outcome);
}

/** Adds the capability allow entry, the delete-child deny and the Low label to a recorded root. */
static napi_value aclApply(napi_env env, napi_callback_info info) {
  napi_value args[6];
  std::wstring input, volumeId, fileId, print, writeSid;
  if (!arguments(env, info, 6, args) || !stringArgument(env, args[0], input) ||
      !stringArgument(env, args[1], volumeId) || !stringArgument(env, args[2], fileId) ||
      !stringArgument(env, args[3], print) || !stringArgument(env, args[5], writeSid))
    return nullptr;
  std::unordered_map<std::wstring, std::wstring> expected;
  if (!aclExpectedObjects(env, args[4], expected)) return nullptr;
  std::vector<BYTE> grantSid, world, low;
  if (!aclCapabilitySid(writeSid, grantSid)) return aclInvalid(env, "Expected a capability SID of the form S-1-4-...");
  if (!aclWellKnownSid(WinWorldSid, world) || !aclWellKnownSid(WinLowLabelSid, low))
    return failure(env, "CreateWellKnownSid", GetLastError());
  AclRecord allow, deny, label;
  DWORD error = aclEntryRecord(aclAllowEntry(writeSid), grantSid, allow);
  if (error == ERROR_SUCCESS) error = aclEntryRecord(aclDenyEntry(), world, deny);
  if (error == ERROR_SUCCESS) error = aclEntryRecord(aclLabelEntry(), low, label);
  if (error != ERROR_SUCCESS) return failure(env, "encode workspace grant entry", error);
  AclProblem problem;
  AclRoot root;
  AclLock lock;
  AclHasher hasher;
  std::wstring rootPrint;
  if (!aclBeginChange(input, volumeId, fileId, print, root, lock, hasher, rootPrint, problem))
    return aclThrow(env, problem);
  const AclGrantPlan plan =
    aclPlanGrant(aclEntries(root.facts.security.dacl), aclEntries(root.facts.security.label), writeSid);
  if (plan.status == AclPlanStatus::SidInUse)
    return aclThrow(env, aclObjectProblem("E_ACL_SID_IN_USE", root.facts, "the write SID already appears on the workspace root"));
  if (plan.status == AclPlanStatus::LabelConflict)
    return aclThrow(env, aclObjectProblem("E_ACL_LABEL_CONFLICT", root.facts, "the workspace root carries another integrity label"));
  std::unordered_map<std::wstring, AclBefore> before;
  if (!aclPrepare(root, hasher, &expected, before, problem)) return aclThrow(env, problem);
  AclWritePlan write;
  const auto entryOf = [](const AclRecord& record) -> const AclAce& { return record.ace; };
  write.dacl = aclGrantedDaclOf(root.facts.security.dacl, plan, allow, deny, entryOf);
  write.label = aclGrantedLabelOf(root.facts.security.label, plan, label);
  write.writeLabel = true;
  write.grantSid = writeSid;
  return aclWriteAndVerify(env, root, hasher, rootPrint, write, before);
}

/** Removes exactly the requested grant entries from a root that still reads as expected. */
static napi_value aclRestore(napi_env env, napi_callback_info info) {
  napi_value args[7];
  std::wstring input, volumeId, fileId, print, allowSid;
  bool removeDeny = false, removeLabel = false;
  if (!arguments(env, info, 7, args) || !stringArgument(env, args[0], input) ||
      !stringArgument(env, args[1], volumeId) || !stringArgument(env, args[2], fileId) ||
      !stringArgument(env, args[3], print) || !aclOptionalText(env, args[4], allowSid))
    return nullptr;
  if (napi_get_value_bool(env, args[5], &removeDeny) != napi_ok || napi_get_value_bool(env, args[6], &removeLabel) != napi_ok)
    return aclInvalid(env, "Expected which grant entries to remove");
  std::vector<BYTE> grantSid;
  if (!allowSid.empty() && !aclCapabilitySid(allowSid, grantSid))
    return aclInvalid(env, "Expected a capability SID of the form S-1-4-...");
  if (allowSid.empty() && !removeDeny && !removeLabel) return aclInvalid(env, "Expected a grant entry to remove");
  AclProblem problem;
  AclRoot root;
  AclLock lock;
  AclHasher hasher;
  std::wstring rootPrint;
  if (!aclBeginChange(input, volumeId, fileId, print, root, lock, hasher, rootPrint, problem))
    return aclThrow(env, problem);
  std::vector<AclAce> daclRemove, labelRemove;
  if (!allowSid.empty()) daclRemove.push_back(aclAllowEntry(allowSid));
  if (removeDeny) daclRemove.push_back(aclDenyEntry());
  if (removeLabel) labelRemove.push_back(aclLabelEntry());
  std::vector<bool> daclGone, labelGone;
  if (!aclRemovalIndices(aclEntries(root.facts.security.dacl), daclRemove, daclGone) ||
      !aclRemovalIndices(aclEntries(root.facts.security.label), labelRemove, labelGone))
    return aclThrow(env, aclObjectProblem("E_ACL_CHANGED", root.facts, "the grant entries are no longer on the workspace root exactly"));
  std::unordered_map<std::wstring, AclBefore> before;
  if (!aclPrepare(root, hasher, nullptr, before, problem)) return aclThrow(env, problem);
  AclWritePlan write;
  for (size_t i = 0; i < root.facts.security.dacl.size(); ++i)
    if (!daclGone[i]) write.dacl.push_back(root.facts.security.dacl[i]);
  for (size_t i = 0; i < root.facts.security.label.size(); ++i)
    if (!labelGone[i]) write.label.push_back(root.facts.security.label[i]);
  write.writeLabel = removeLabel;
  write.removedSid = allowSid;
  return aclWriteAndVerify(env, root, hasher, rootPrint, write, before);
}
