#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <appmodel.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <softpub.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <psapi.h>
#include <node_api.h>
#include <uv.h>
#include <cmath>
#include <memory>
#include <string>
#include <vector>
#include <algorithm>
#include "private-dacl-policy.h"

class Handle {
 public:
  explicit Handle(HANDLE h) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE value;
};
struct LocalRelease { void operator()(void* p) const { if (p) LocalFree(p); } };
using Local = std::unique_ptr<void, LocalRelease>;

static napi_value failure(napi_env env, const char* operation, DWORD error) {
  const char* code = "EIO";
  switch (error) {
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: code = "ENOENT"; break;
    case ERROR_ACCESS_DENIED: code = "EACCES"; break;
    case ERROR_SHARING_VIOLATION: case ERROR_LOCK_VIOLATION: code = "EBUSY"; break;
    case ERROR_ALREADY_EXISTS: case ERROR_FILE_EXISTS: code = "EEXIST"; break;
    case ERROR_NOT_SAME_DEVICE: code = "EXDEV"; break;
    case ERROR_DIR_NOT_EMPTY: code = "ENOTEMPTY"; break;
    case ERROR_INVALID_NAME: case ERROR_INVALID_PARAMETER: code = "EINVAL"; break;
    case ERROR_TOO_MANY_OPEN_FILES: code = "EMFILE"; break;
    case ERROR_DIRECTORY: code = "ENOTDIR"; break;
    case ERROR_FILE_TOO_LARGE: code = "EFBIG"; break;
  }
  napi_value message, result, name, number;
  const std::string text = std::string(operation) + " failed";
  napi_create_string_utf8(env, text.c_str(), NAPI_AUTO_LENGTH, &message);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &name);
  napi_create_error(env, name, message, &result);
  napi_create_uint32(env, error, &number);
  napi_set_named_property(env, result, "win32Code", number);
  napi_throw(env, result);
  return nullptr;
}
static bool stringArgument(napi_env env, napi_value arg, std::wstring& out) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, arg, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > 32766) {
    napi_throw_type_error(env, "EINVAL", "Expected a nonempty Windows path");
    return false;
  }
  out.resize(length + 1);
  if (napi_get_value_string_utf16(env, arg, reinterpret_cast<char16_t*>(out.data()),
                                length + 1, &length) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "Cannot read Windows path"); return false;
  }
  out.resize(length);
  if (out.find(L'\0') != std::wstring::npos) {
    napi_throw_type_error(env, "EINVAL", "Path contains NUL");
    return false;
  }
  return true;
}
static bool arguments(napi_env env, napi_callback_info info, size_t count, napi_value* args) {
  size_t actual = count;
  if (napi_get_cb_info(env, info, &actual, args, nullptr, nullptr) != napi_ok || actual != count) {
    napi_throw_type_error(env, "EINVAL", "Missing Windows path argument"); return false;
  }
  return true;
}
static bool userToken(napi_env env, std::vector<BYTE>& data) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) {
    failure(env, "OpenProcessToken", GetLastError()); return false;
  }
  Handle token(raw);
  DWORD size = 0;
  GetTokenInformation(raw, TokenUser, nullptr, 0, &size);
  if (!size) { failure(env, "GetTokenInformation", GetLastError()); return false; }
  data.resize(size);
  if (!GetTokenInformation(raw, TokenUser, data.data(), size, &size)) {
    failure(env, "GetTokenInformation", GetLastError()); return false;
  }
  return true;
}
static Local privateSecurity(napi_env env) {
  std::vector<BYTE> token;
  if (!userToken(env, token)) return {};
  LPWSTR rawSid = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(token.data())->User.Sid, &rawSid)) {
    failure(env, "ConvertSidToStringSid", GetLastError()); return {};
  }
  Local sid(rawSid);
  const std::wstring sddl = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + std::wstring(rawSid) + L")";
  PSECURITY_DESCRIPTOR raw = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &raw, nullptr)) {
    failure(env, "ConvertStringSecurityDescriptor", GetLastError()); return {};
  }
  return Local(raw);
}
static napi_value adoptFile(napi_env env, Handle& file) {
  const int fd = uv_open_osfhandle(file.value);
  if (fd == -1) return failure(env, "uv_open_osfhandle", ERROR_TOO_MANY_OPEN_FILES);
  file.value = INVALID_HANDLE_VALUE; // Node/libuv now owns the handle.
  napi_value result;
  if (napi_create_int32(env, fd, &result) != napi_ok) {
    uv_fs_t request;
    uv_fs_close(nullptr, &request, fd, nullptr);
    uv_fs_req_cleanup(&request);
    return nullptr;
  }
  return result;
}
static napi_value createPrivate(napi_env env, napi_callback_info info, bool directory, bool temporary = false) {
  napi_value args[1]; std::wstring path;
  if (!arguments(env, info, 1, args) || !stringArgument(env, args[0], path)) return nullptr;
  Local descriptor = privateSecurity(env);
  if (!descriptor) return nullptr;
  SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), descriptor.get(), FALSE};
  napi_value result;
  if (directory) {
    if (!CreateDirectoryW(path.c_str(), &sa)) return failure(env, "CreateDirectoryW", GetLastError());
    napi_get_undefined(env, &result);
    return result;
  }
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | (temporary ? DELETE : 0),
                         FILE_SHARE_READ | FILE_SHARE_DELETE | (temporary ? 0 : FILE_SHARE_WRITE), &sa, CREATE_NEW,
                         FILE_FLAG_OPEN_REPARSE_POINT | (temporary ? FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE : FILE_ATTRIBUTE_NORMAL), nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return failure(env, "CreateFileW", GetLastError());
  // Use Node's descriptor table, never this addon's potentially separate CRT table.
  return adoptFile(env, file);
}
static napi_value createFile(napi_env env, napi_callback_info info) { return createPrivate(env, info, false); }
static napi_value createTemporaryFile(napi_env env, napi_callback_info info) { return createPrivate(env, info, false, true); }
static napi_value createDirectory(napi_env env, napi_callback_info info) { return createPrivate(env, info, true); }

static napi_value renameDirectoryNoReplace(napi_env env, napi_callback_info info) {
  napi_value args[2]; std::wstring from, to;
  if (!arguments(env, info, 2, args) || !stringArgument(env, args[0], from) || !stringArgument(env, args[1], to)) return nullptr;
  const DWORD attributes = GetFileAttributesW(from.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) return failure(env, "inspect source directory", GetLastError());
  if (!(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
    return failure(env, "real source directory required", ERROR_ACCESS_DENIED);
  if (!MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_WRITE_THROUGH))
    return failure(env, "rename directory without replacement", GetLastError());
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value renameWriteThrough(napi_env env, napi_callback_info info) {
  napi_value args[2]; std::wstring from, to;
  if (!arguments(env, info, 2, args) || !stringArgument(env, args[0], from) || !stringArgument(env, args[1], to)) return nullptr;
  if (!MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    return failure(env, "MoveFileExW", GetLastError());
  napi_value result; napi_get_undefined(env, &result); return result;
}

static PrivatePrincipal privatePrincipal(PSID sid, PSID user) {
  if (EqualSid(sid, user)) return PrivatePrincipal::CurrentUser;
  if (IsWellKnownSid(sid, WinLocalSystemSid)) return PrivatePrincipal::LocalSystem;
  if (IsWellKnownSid(sid, WinBuiltinAdministratorsSid)) return PrivatePrincipal::Administrators;
  return PrivatePrincipal::Other;
}
static bool checkPrivateDacl(napi_env env, HANDLE file, bool& valid, bool requireProtected = true) {
  BY_HANDLE_FILE_INFORMATION attributes;
  if (!GetFileInformationByHandle(file, &attributes)) {
    failure(env, "GetFileInformationByHandle", GetLastError()); return false;
  }
  PSID owner = nullptr; PACL dacl = nullptr; PSECURITY_DESCRIPTOR raw = nullptr;
  const DWORD status = GetSecurityInfo(file, SE_FILE_OBJECT,
                                      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                                      &owner, nullptr, &dacl, nullptr, &raw);
  if (status != ERROR_SUCCESS) { failure(env, "GetSecurityInfo", status); return false; }
  Local descriptor(raw);
  std::vector<BYTE> token;
  if (!userToken(env, token)) return false;
  PSID user = reinterpret_cast<TOKEN_USER*>(token.data())->User.Sid;
  SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
  if (!GetSecurityDescriptorControl(raw, &control, &revision)) {
    failure(env, "GetSecurityDescriptorControl", GetLastError()); return false;
  }
  valid = owner && privateOwnerTrusted(privatePrincipal(owner, user)) && dacl &&
          (!requireProtected || (control & SE_DACL_PROTECTED)) &&
          !(attributes.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT);
  if (valid) {
    for (DWORD i = 0; i < dacl->AceCount; i++) {
      void* rawAce = nullptr;
      if (!GetAce(dacl, i, &rawAce)) { failure(env, "GetAce", GetLastError()); return false; }
      auto* header = static_cast<ACE_HEADER*>(rawAce);
      PrivateAce entry{PrivateAceKind::Unsupported, 0, PrivatePrincipal::Other};
      if (header->AceType == ACCESS_DENIED_ACE_TYPE) entry.kind = PrivateAceKind::Denied;
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
        entry = {PrivateAceKind::Allowed, ace->Mask, privatePrincipal(&ace->SidStart, user)};
      }
      if (!privateAceTrusted(entry)) { valid = false; break; }
    }
  }
  return true;
}
static napi_value privateDacl(napi_env env, napi_callback_info info) {
  napi_value args[1]; std::wstring path;
  if (!arguments(env, info, 1, args) || !stringArgument(env, args[0], path)) return nullptr;
  Handle file(CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
                         FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                         FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return failure(env, "CreateFileW", GetLastError());
  bool valid = false;
  if (!checkPrivateDacl(env, file.value, valid)) return nullptr;
  napi_value result; napi_get_boolean(env, valid, &result); return result;
}
struct WipeBytes {
  std::vector<BYTE>& bytes;
  ~WipeBytes() { SecureZeroMemory(bytes.data(), bytes.size()); }
};
static napi_value protectPrivateFile(napi_env env, napi_callback_info info) {
  napi_value args[1]; std::wstring path;
  if (!arguments(env, info, 1, args) || !stringArgument(env, args[0], path)) return nullptr;
  Handle file(CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
                         0, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return failure(env, "CreateFileW private file", GetLastError());
  BY_HANDLE_FILE_INFORMATION attributes;
  if (!GetFileInformationByHandle(file.value, &attributes))
    return failure(env, "GetFileInformationByHandle", GetLastError());
  if ((attributes.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || attributes.nNumberOfLinks != 1)
    return failure(env, "Private file validation", ERROR_ACCESS_DENIED);
  bool valid = false;
  if (!checkPrivateDacl(env, file.value, valid, false)) return nullptr;
  if (!valid) return failure(env, "Private file validation", ERROR_ACCESS_DENIED);
  PACL dacl = nullptr; PSECURITY_DESCRIPTOR raw = nullptr;
  DWORD status = GetSecurityInfo(file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                nullptr, nullptr, &dacl, nullptr, &raw);
  if (status != ERROR_SUCCESS) return failure(env, "GetSecurityInfo", status);
  Local descriptor(raw);
  // Freeze only already-private access; never add grants, change owner or replace file bytes.
  status = SetSecurityInfo(file.value, SE_FILE_OBJECT,
                          DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                          nullptr, nullptr, dacl, nullptr);
  if (status != ERROR_SUCCESS) return failure(env, "SetSecurityInfo", status);
  if (!checkPrivateDacl(env, file.value, valid)) return nullptr;
  if (!valid) return failure(env, "Private file validation", ERROR_ACCESS_DENIED);
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value protectPrivateDirectory(napi_env env, napi_callback_info info) {
  napi_value args[1]; std::wstring path;
  if (!arguments(env, info, 1, args) || !stringArgument(env, args[0], path)) return nullptr;
  Handle directory(CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
                              0, nullptr, OPEN_EXISTING,
                              FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (directory.value == INVALID_HANDLE_VALUE) return failure(env, "CreateFileW", GetLastError());
  BY_HANDLE_FILE_INFORMATION attributes;
  if (!GetFileInformationByHandle(directory.value, &attributes))
    return failure(env, "GetFileInformationByHandle", GetLastError());
  if (!(attributes.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
    return failure(env, "Private directory validation", ERROR_DIRECTORY);
  bool valid = false;
  if (!checkPrivateDacl(env, directory.value, valid, false)) return nullptr;
  if (!valid) return failure(env, "Private directory validation", ERROR_ACCESS_DENIED);
  PACL dacl = nullptr; PSECURITY_DESCRIPTOR raw = nullptr;
  DWORD status = GetSecurityInfo(directory.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                nullptr, nullptr, &dacl, nullptr, &raw);
  if (status != ERROR_SUCCESS) return failure(env, "GetSecurityInfo", status);
  Local descriptor(raw);
  // SetSecurityInfo propagates a container's inheritable entries into every existing child,
  // whatever the handle's sharing mode, so it would rewrite the children's ACLs. Set the
  // descriptor on this handle alone instead, which never propagates. A protected ACL no longer
  // inherits, so the entries this directory inherited are kept as its own explicit entries.
  if (!dacl) return failure(env, "Private directory validation", ERROR_ACCESS_DENIED);
  for (DWORD i = 0; i < dacl->AceCount; i++) {
    void* rawAce = nullptr;
    if (!GetAce(dacl, i, &rawAce)) return failure(env, "GetAce", GetLastError());
    auto* header = static_cast<ACE_HEADER*>(rawAce);
    header->AceFlags = static_cast<BYTE>(header->AceFlags & ~INHERITED_ACE);
  }
  SECURITY_DESCRIPTOR frozen;
  if (!InitializeSecurityDescriptor(&frozen, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorDacl(&frozen, TRUE, dacl, FALSE) ||
      !SetSecurityDescriptorControl(&frozen, SE_DACL_PROTECTED, SE_DACL_PROTECTED))
    return failure(env, "Private directory descriptor", GetLastError());
  if (!SetKernelObjectSecurity(directory.value, DACL_SECURITY_INFORMATION, &frozen))
    return failure(env, "SetKernelObjectSecurity", GetLastError());
  if (!checkPrivateDacl(env, directory.value, valid)) return nullptr;
  if (!valid) return failure(env, "Private directory validation", ERROR_ACCESS_DENIED);
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value openPrivateFile(napi_env env, napi_callback_info info) {
  napi_value args[1]; std::wstring path;
  if (!arguments(env, info, 1, args) || !stringArgument(env, args[0], path)) return nullptr;
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
                         nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return failure(env, "CreateFileW", GetLastError());
  bool valid = false;
  if (!checkPrivateDacl(env, file.value, valid)) return nullptr;
  BY_HANDLE_FILE_INFORMATION infoFile;
  if (!GetFileInformationByHandle(file.value, &infoFile)) return failure(env, "GetFileInformationByHandle", GetLastError());
  if (!valid || infoFile.nNumberOfLinks != 1 ||
      (infoFile.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)))
    return failure(env, "Private file validation", ERROR_ACCESS_DENIED);
  return adoptFile(env, file);
}
static napi_value readPrivateFile(napi_env env, napi_callback_info info) {
  napi_value args[2]; std::wstring path; double maximum = 0;
  if (!arguments(env, info, 2, args) || !stringArgument(env, args[0], path)) return nullptr;
  if (napi_get_value_double(env, args[1], &maximum) != napi_ok || !std::isfinite(maximum) ||
      maximum < 0 || maximum > 16777216 || maximum != std::floor(maximum)) {
    napi_throw_type_error(env, "EINVAL", "Invalid private file read limit"); return nullptr;
  }
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
                         nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return failure(env, "CreateFileW", GetLastError());
  bool valid = false;
  if (!checkPrivateDacl(env, file.value, valid)) return nullptr;
  BY_HANDLE_FILE_INFORMATION before;
  if (!GetFileInformationByHandle(file.value, &before)) return failure(env, "GetFileInformationByHandle", GetLastError());
  if (!valid || before.nNumberOfLinks != 1 ||
      (before.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)))
    return failure(env, "Private file validation", ERROR_ACCESS_DENIED);
  if (before.nFileSizeHigh || before.nFileSizeLow > maximum)
    return failure(env, "Private file size", ERROR_FILE_TOO_LARGE);
  std::vector<BYTE> bytes(static_cast<size_t>(maximum) + 1);
  WipeBytes wipe{bytes};
  DWORD total = 0;
  while (total < bytes.size()) {
    DWORD count = 0;
    if (!ReadFile(file.value, bytes.data() + total, static_cast<DWORD>(bytes.size() - total), &count, nullptr))
      return failure(env, "ReadFile", GetLastError());
    if (!count) break;
    total += count;
  }
  if (total > maximum) return failure(env, "Private file size", ERROR_FILE_TOO_LARGE);
  BY_HANDLE_FILE_INFORMATION after;
  if (!GetFileInformationByHandle(file.value, &after)) return failure(env, "GetFileInformationByHandle", GetLastError());
  if (!checkPrivateDacl(env, file.value, valid)) return nullptr;
  if (!valid || after.nNumberOfLinks != 1 || after.nFileSizeHigh || after.nFileSizeLow != total ||
      before.nFileSizeLow != total || CompareFileTime(&before.ftLastWriteTime, &after.ftLastWriteTime) != 0)
    return failure(env, "Private file changed", ERROR_ACCESS_DENIED);
  napi_value result;
  if (napi_create_buffer_copy(env, total, bytes.data(), nullptr, &result) != napi_ok) return nullptr;
  return result;
}
static napi_value syncDirectory(napi_env env, napi_callback_info info) {
  napi_value args[1]; std::wstring path;
  if (!arguments(env, info, 1, args) || !stringArgument(env, args[0], path)) return nullptr;
  Handle directory(CreateFileW(path.c_str(), GENERIC_WRITE,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              nullptr, OPEN_EXISTING,
                              FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (directory.value == INVALID_HANDLE_VALUE) return failure(env, "CreateFileW", GetLastError());
  BY_HANDLE_FILE_INFORMATION infoValue;
  if (!GetFileInformationByHandle(directory.value, &infoValue))
    return failure(env, "GetFileInformationByHandle", GetLastError());
  if (!(infoValue.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
    return failure(env, "Directory synchronization", ERROR_DIRECTORY);
  if (infoValue.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    return failure(env, "Directory synchronization", ERROR_ACCESS_DENIED);
  if (!FlushFileBuffers(directory.value)) return failure(env, "FlushFileBuffers", GetLastError());
  napi_value result; napi_get_undefined(env, &result); return result;
}

struct BCryptAlgorithmRelease { void operator()(BCRYPT_ALG_HANDLE value) const { if (value) BCryptCloseAlgorithmProvider(value, 0); } };
struct BCryptHashRelease { void operator()(BCRYPT_HASH_HANDLE value) const { if (value) BCryptDestroyHash(value); } };
static std::string hexLower(const BYTE* bytes, DWORD size);

static bool hashFileSha256(napi_env env, HANDLE file, std::string& digest, ULONGLONG& byteCount) {
  BCRYPT_ALG_HANDLE rawAlgorithm = nullptr;
  NTSTATUS status = BCryptOpenAlgorithmProvider(&rawAlgorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
  if (status < 0) { failure(env, "BCryptOpenAlgorithmProvider", static_cast<DWORD>(status)); return false; }
  std::unique_ptr<void, BCryptAlgorithmRelease> algorithm(rawAlgorithm);
  DWORD objectSize = 0, resultSize = 0;
  status = BCryptGetProperty(rawAlgorithm, BCRYPT_OBJECT_LENGTH,
                             reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &resultSize, 0);
  if (status < 0 || resultSize != sizeof(objectSize)) {
    failure(env, "BCryptGetProperty", static_cast<DWORD>(status)); return false;
  }
  std::vector<BYTE> object(objectSize);
  BCRYPT_HASH_HANDLE rawHash = nullptr;
  status = BCryptCreateHash(rawAlgorithm, &rawHash, object.data(), objectSize, nullptr, 0, 0);
  if (status < 0) { failure(env, "BCryptCreateHash", static_cast<DWORD>(status)); return false; }
  std::unique_ptr<void, BCryptHashRelease> hash(rawHash);
  LARGE_INTEGER zero = {};
  if (!SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) return failure(env, "SetFilePointerEx", GetLastError()), false;
  std::vector<BYTE> buffer(64 * 1024);
  byteCount = 0;
  for (;;) {
    DWORD count = 0;
    if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr))
      return failure(env, "ReadFile", GetLastError()), false;
    if (!count) break;
    byteCount += count;
    status = BCryptHashData(rawHash, buffer.data(), count, 0);
    if (status < 0) return failure(env, "BCryptHashData", static_cast<DWORD>(status)), false;
  }
  BYTE bytes[32];
  status = BCryptFinishHash(rawHash, bytes, sizeof(bytes), 0);
  if (status < 0) return failure(env, "BCryptFinishHash", static_cast<DWORD>(status)), false;
  digest = hexLower(bytes, sizeof(bytes));
  return true;
}

static bool finalPath(napi_env env, HANDLE handle, std::wstring& path) {
  DWORD required = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!required) return failure(env, "GetFinalPathNameByHandleW", GetLastError()), false;
  path.resize(required);
  DWORD written = GetFinalPathNameByHandleW(handle, path.data(), required,
                                             FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!written || written >= required) return failure(env, "GetFinalPathNameByHandleW", GetLastError()), false;
  path.resize(written);
  return true;
}

static bool finalNtPath(napi_env env, HANDLE handle, std::wstring& path) {
  DWORD required = GetFinalPathNameByHandleW(handle, nullptr, 0,
                                              FILE_NAME_NORMALIZED | VOLUME_NAME_NT);
  if (!required) return failure(env, "GetFinalPathNameByHandleW", GetLastError()), false;
  path.resize(required);
  DWORD written = GetFinalPathNameByHandleW(handle, path.data(), required,
                                             FILE_NAME_NORMALIZED | VOLUME_NAME_NT);
  if (!written || written >= required)
    return failure(env, "GetFinalPathNameByHandleW", GetLastError()), false;
  path.resize(written);
  return true;
}

struct MappedImageSnapshot {
  HMODULE base = nullptr;
  std::wstring path;
};

static bool mainMappedImage(napi_env env, HANDLE process, MappedImageSnapshot& result) {
  HMODULE module = nullptr;
  DWORD required = 0;
  if (!K32EnumProcessModulesEx(process, &module, sizeof(module), &required, LIST_MODULES_ALL))
    return failure(env, "K32EnumProcessModulesEx", GetLastError()), false;
  if (!module || required < sizeof(module))
    return failure(env, "Process mapped image", ERROR_INVALID_PARAMETER), false;
  MEMORY_BASIC_INFORMATION region = {};
  if (VirtualQueryEx(process, module, &region, sizeof(region)) != sizeof(region))
    return failure(env, "VirtualQueryEx", GetLastError()), false;
  if (region.State != MEM_COMMIT || region.Type != MEM_IMAGE || region.AllocationBase != module)
    return failure(env, "Process mapped image", ERROR_INVALID_PARAMETER), false;
  std::wstring path(1024, L'\0');
  for (;;) {
    const DWORD written = K32GetMappedFileNameW(process, module, path.data(),
                                                static_cast<DWORD>(path.size()));
    if (!written) return failure(env, "K32GetMappedFileNameW", GetLastError()), false;
    if (written < path.size() - 1) {
      path.resize(written);
      break;
    }
    if (path.size() >= 32768)
      return failure(env, "K32GetMappedFileNameW", ERROR_FILENAME_EXCED_RANGE), false;
    path.resize(std::min<size_t>(path.size() * 2, 32768));
  }
  result.base = module;
  result.path = std::move(path);
  return true;
}

static bool windowsPathEqual(const std::wstring& left, const std::wstring& right) {
  return left.size() <= static_cast<size_t>(INT_MAX) &&
         right.size() <= static_cast<size_t>(INT_MAX) &&
         CompareStringOrdinal(left.data(), static_cast<int>(left.size()),
                              right.data(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

static bool artifactRelativePath(const std::wstring& value) {
  if (value.size() != 2 + 1 + 64 || value[2] != L'\\') return false;
  for (size_t i = 0; i < value.size(); ++i) {
    if (i == 2) continue;
    const wchar_t c = value[i];
    if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return false;
  }
  return value.substr(0, 2) == value.substr(3, 2);
}

/** Hashes and deletes the exact handle only after proving it remains beneath the private store root. */
static napi_value deletePrivateArtifact(napi_env env, napi_callback_info info) {
  napi_value args[3]; std::wstring root, relative, expectedWide;
  if (!arguments(env, info, 3, args) || !stringArgument(env, args[0], root) ||
      !stringArgument(env, args[1], relative) || !stringArgument(env, args[2], expectedWide)) return nullptr;
  if (!artifactRelativePath(relative) || expectedWide.size() != 64 || relative.substr(3) != expectedWide) {
    napi_throw_type_error(env, "EINVAL", "Invalid content-addressed artifact identity"); return nullptr;
  }
  Handle rootHandle(CreateFileW(root.c_str(), GENERIC_READ | READ_CONTROL,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               nullptr, OPEN_EXISTING,
                               FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (rootHandle.value == INVALID_HANDLE_VALUE) return failure(env, "CreateFileW", GetLastError());
  bool privateRoot = false;
  if (!checkPrivateDacl(env, rootHandle.value, privateRoot)) return nullptr;
  BY_HANDLE_FILE_INFORMATION rootInfo;
  if (!GetFileInformationByHandle(rootHandle.value, &rootInfo))
    return failure(env, "GetFileInformationByHandle", GetLastError());
  if (!privateRoot || !(rootInfo.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (rootInfo.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
    return failure(env, "Private artifact root validation", ERROR_ACCESS_DENIED);
  std::wstring target = root;
  if (!target.empty() && target.back() != L'\\') target.push_back(L'\\');
  target += relative;
  Handle file(CreateFileW(target.c_str(), GENERIC_READ | DELETE | READ_CONTROL,
                          FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                          FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return failure(env, "CreateFileW", GetLastError());
  bool privateFile = false;
  if (!checkPrivateDacl(env, file.value, privateFile)) return nullptr;
  BY_HANDLE_FILE_INFORMATION fileInfo;
  if (!GetFileInformationByHandle(file.value, &fileInfo))
    return failure(env, "GetFileInformationByHandle", GetLastError());
  if (!privateFile || fileInfo.nNumberOfLinks != 1 ||
      (fileInfo.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)))
    return failure(env, "Private artifact validation", ERROR_ACCESS_DENIED);
  std::wstring finalRoot, finalFile;
  if (!finalPath(env, rootHandle.value, finalRoot) || !finalPath(env, file.value, finalFile)) return nullptr;
  if (!finalRoot.empty() && finalRoot.back() != L'\\') finalRoot.push_back(L'\\');
  if (finalFile.size() <= finalRoot.size() ||
      CompareStringOrdinal(finalRoot.data(), static_cast<int>(finalRoot.size()),
                           finalFile.data(), static_cast<int>(finalRoot.size()), TRUE) != CSTR_EQUAL)
    return failure(env, "Artifact root containment", ERROR_ACCESS_DENIED);
  std::string digest; ULONGLONG byteCount = 0;
  if (!hashFileSha256(env, file.value, digest, byteCount)) return nullptr;
  std::string expected;
  expected.reserve(expectedWide.size());
  for (wchar_t value : expectedWide) expected.push_back(static_cast<char>(value));
  if (digest != expected) return failure(env, "Artifact digest validation", ERROR_ACCESS_DENIED);
  BY_HANDLE_FILE_INFORMATION after;
  if (!GetFileInformationByHandle(file.value, &after))
    return failure(env, "GetFileInformationByHandle", GetLastError());
  std::wstring finalFileAfter;
  if (!finalPath(env, file.value, finalFileAfter)) return nullptr;
  if (after.dwVolumeSerialNumber != fileInfo.dwVolumeSerialNumber ||
      after.nFileIndexHigh != fileInfo.nFileIndexHigh ||
      after.nFileIndexLow != fileInfo.nFileIndexLow ||
      after.nNumberOfLinks != fileInfo.nNumberOfLinks ||
      after.nFileSizeHigh != fileInfo.nFileSizeHigh ||
      after.nFileSizeLow != fileInfo.nFileSizeLow ||
      !windowsPathEqual(finalFileAfter, finalFile))
    return failure(env, "Artifact identity changed", ERROR_ACCESS_DENIED);
  FILE_DISPOSITION_INFO disposition = { TRUE };
  if (!SetFileInformationByHandle(file.value, FileDispositionInfo, &disposition, sizeof(disposition)))
    return failure(env, "SetFileInformationByHandle", GetLastError());
  napi_value result;
  napi_create_bigint_uint64(env, byteCount, &result);
  return result;
}

template<napi_callback Callback>
static napi_value guarded(napi_env env, napi_callback_info info) {
  try { return Callback(env, info); }
  catch (...) { napi_throw_error(env, "E_NATIVE_FAILURE", "Windows system operation failed"); return nullptr; }
}
static napi_value processStartTime(napi_env env, napi_callback_info info) {
  napi_value args[1], result; double input = 0;
  if (!arguments(env, info, 1, args)) return nullptr;
  if (napi_get_value_double(env, args[0], &input) != napi_ok || !std::isfinite(input) ||
      input < 1 || input > 4294967295.0 || input != std::floor(input)) {
    napi_throw_type_error(env, "EINVAL", "Expected a positive Windows process ID"); return nullptr;
  }
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD>(input)));
  if (!process.value) {
    const DWORD error = GetLastError();
    if (error == ERROR_INVALID_PARAMETER) { napi_get_null(env, &result); return result; }
    return failure(env, "OpenProcess", error);
  }
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process.value, &created, &exited, &kernel, &user))
    return failure(env, "GetProcessTimes", GetLastError());
  const DWORD state = WaitForSingleObject(process.value, 0);
  if (state == WAIT_OBJECT_0) { napi_get_null(env, &result); return result; }
  if (state != WAIT_TIMEOUT) return failure(env, "WaitForSingleObject", GetLastError());
  ULARGE_INTEGER time; time.HighPart = created.dwHighDateTime; time.LowPart = created.dwLowDateTime;
  const std::string text = std::to_string(time.QuadPart);
  napi_create_string_utf8(env, text.c_str(), text.size(), &result);
  return result;
}

struct CertStoreRelease { void operator()(HCERTSTORE value) const { if (value) CertCloseStore(value, 0); } };
struct CryptMessageRelease { void operator()(HCRYPTMSG value) const { if (value) CryptMsgClose(value); } };
struct CertContextRelease { void operator()(const CERT_CONTEXT* value) const { if (value) CertFreeCertificateContext(value); } };

static std::string hexLower(const BYTE* bytes, DWORD size) {
  static const char digits[] = "0123456789abcdef";
  std::string value(size * 2, '\0');
  for (DWORD i = 0; i < size; ++i) {
    value[i * 2] = digits[bytes[i] >> 4];
    value[i * 2 + 1] = digits[bytes[i] & 0x0f];
  }
  return value;
}

static bool verifiedPublisherIdentity(napi_env env, const std::wstring& path, HANDLE handle,
                                      std::string& digest,
                                      std::string* sha1 = nullptr, std::wstring* subject = nullptr) {
  WINTRUST_FILE_INFO file = {};
  file.cbStruct = sizeof(file);
  file.pcwszFilePath = path.c_str();
  file.hFile = handle;
  WINTRUST_DATA trust = {};
  trust.cbStruct = sizeof(trust);
  trust.dwUIChoice = WTD_UI_NONE;
  trust.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
  trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &file;
  trust.dwStateAction = WTD_STATEACTION_VERIFY;
  trust.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG verified = WinVerifyTrust(nullptr, &action, &trust);
  trust.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(nullptr, &action, &trust);
  if (verified != ERROR_SUCCESS) {
    failure(env, "WinVerifyTrust", static_cast<DWORD>(verified));
    return false;
  }

  HCERTSTORE rawStore = nullptr;
  HCRYPTMSG rawMessage = nullptr;
  DWORD encoding = 0, content = 0, format = 0;
  if (!CryptQueryObject(CERT_QUERY_OBJECT_FILE, path.c_str(),
                        CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
                        CERT_QUERY_FORMAT_FLAG_BINARY, 0, &encoding, &content, &format,
                        &rawStore, &rawMessage, nullptr)) {
    failure(env, "CryptQueryObject", GetLastError());
    return false;
  }
  std::unique_ptr<void, CertStoreRelease> store(rawStore);
  std::unique_ptr<void, CryptMessageRelease> message(rawMessage);
  DWORD signerSize = 0;
  if (!CryptMsgGetParam(rawMessage, CMSG_SIGNER_INFO_PARAM, 0, nullptr, &signerSize)) {
    failure(env, "CryptMsgGetParam", GetLastError());
    return false;
  }
  std::vector<BYTE> signerBytes(signerSize);
  if (!CryptMsgGetParam(rawMessage, CMSG_SIGNER_INFO_PARAM, 0, signerBytes.data(), &signerSize)) {
    failure(env, "CryptMsgGetParam", GetLastError());
    return false;
  }
  const CMSG_SIGNER_INFO* signer = reinterpret_cast<CMSG_SIGNER_INFO*>(signerBytes.data());
  CERT_INFO query = {};
  query.Issuer = signer->Issuer;
  query.SerialNumber = signer->SerialNumber;
  const CERT_CONTEXT* rawCertificate = CertFindCertificateInStore(
      rawStore, encoding, 0, CERT_FIND_SUBJECT_CERT, &query, nullptr);
  if (!rawCertificate) {
    failure(env, "CertFindCertificateInStore", GetLastError());
    return false;
  }
  std::unique_ptr<const CERT_CONTEXT, CertContextRelease> certificate(rawCertificate);
  BYTE hash[32];
  DWORD hashSize = sizeof(hash);
  if (!CertGetCertificateContextProperty(rawCertificate, CERT_SHA256_HASH_PROP_ID, hash, &hashSize) ||
      hashSize != sizeof(hash)) {
    failure(env, "CertGetCertificateContextProperty", GetLastError());
    return false;
  }
  digest = hexLower(hash, hashSize);
  if (sha1) {
    BYTE sha1Bytes[20];
    DWORD sha1Size = sizeof(sha1Bytes);
    if (!CertGetCertificateContextProperty(rawCertificate, CERT_SHA1_HASH_PROP_ID, sha1Bytes, &sha1Size) ||
        sha1Size != sizeof(sha1Bytes)) {
      failure(env, "CertGetCertificateContextProperty", GetLastError());
      return false;
    }
    *sha1 = hexLower(sha1Bytes, sha1Size);
  }
  if (subject) {
    const DWORD size = CertGetNameStringW(rawCertificate, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, nullptr, nullptr, 0);
    if (size <= 1) { failure(env, "CertGetNameStringW", GetLastError()); return false; }
    subject->resize(size);
    if (!CertGetNameStringW(rawCertificate, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, nullptr, subject->data(), size)) {
      failure(env, "CertGetNameStringW", GetLastError()); return false;
    }
    subject->resize(size - 1);
  }
  return true;
}

static bool processPackageFamily(napi_env env, HANDLE process, bool& packaged,
                                 std::wstring& family) {
  UINT32 length = 0;
  LONG status = GetPackageFamilyName(process, &length, nullptr);
  if (status == APPMODEL_ERROR_NO_PACKAGE) {
    packaged = false;
    family.clear();
    return true;
  }
  if (status != ERROR_INSUFFICIENT_BUFFER || length <= 1) {
    failure(env, "GetPackageFamilyName", static_cast<DWORD>(status));
    return false;
  }
  std::vector<WCHAR> buffer(length);
  status = GetPackageFamilyName(process, &length, buffer.data());
  if (status != ERROR_SUCCESS || length <= 1) {
    failure(env, "GetPackageFamilyName", static_cast<DWORD>(status));
    return false;
  }
  packaged = true;
  family.assign(buffer.data(), length - 1);
  return true;
}

static napi_value executableFileIdentity(napi_env env, napi_callback_info info) {
  napi_value args[1]; std::wstring path;
  if (!arguments(env, info, 1, args) || !stringArgument(env, args[0], path)) return nullptr;
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL,
                          FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                          FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return failure(env, "CreateFileW", GetLastError());
  BY_HANDLE_FILE_INFORMATION fileInfo;
  if (!GetFileInformationByHandle(file.value, &fileInfo))
    return failure(env, "GetFileInformationByHandle", GetLastError());
  if (fileInfo.nNumberOfLinks != 1 ||
      (fileInfo.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)))
    return failure(env, "Executable file validation", ERROR_ACCESS_DENIED);
  std::wstring final;
  if (!finalPath(env, file.value, final)) return nullptr;
  std::string sha256, sha1; std::wstring subject;
  if (!verifiedPublisherIdentity(env, final, file.value, sha256, &sha1, &subject)) return nullptr;
  napi_value result, pathValue, sha256Value, sha1Value, subjectValue;
  napi_create_object(env, &result);
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(final.data()), final.size(), &pathValue);
  napi_create_string_utf8(env, sha256.c_str(), sha256.size(), &sha256Value);
  napi_create_string_utf8(env, sha1.c_str(), sha1.size(), &sha1Value);
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(subject.data()), subject.size(), &subjectValue);
  napi_set_named_property(env, result, "executablePath", pathValue);
  napi_set_named_property(env, result, "publisherSha256", sha256Value);
  napi_set_named_property(env, result, "leafThumbprint", sha1Value);
  napi_set_named_property(env, result, "publisher", subjectValue);
  return result;
}

/** Binds the live process main MEM_IMAGE mapping to the exact replacement-locked file handle used
 * for Authenticode verification. Any inaccessible or unstable evidence fails closed. */
static napi_value processExecutableIdentity(napi_env env, napi_callback_info info) {
  napi_value args[1]; double input = 0;
  if (!arguments(env, info, 1, args)) return nullptr;
  if (napi_get_value_double(env, args[0], &input) != napi_ok || !std::isfinite(input) ||
      input < 1 || input > 4294967295.0 || input != std::floor(input)) {
    napi_throw_type_error(env, "EINVAL", "Expected a positive Windows process ID"); return nullptr;
  }
  Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE,
                             FALSE, static_cast<DWORD>(input)));
  if (!process.value) return failure(env, "OpenProcess", GetLastError());
  if (WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT)
    return failure(env, "Process identity", ERROR_INVALID_PARAMETER);
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process.value, &created, &exited, &kernel, &user))
    return failure(env, "GetProcessTimes", GetLastError());
  MappedImageSnapshot mapped;
  if (!mainMappedImage(env, process.value, mapped)) return nullptr;
  std::wstring path(32768, L'\0');
  DWORD pathSize = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(process.value, 0, path.data(), &pathSize))
    return failure(env, "QueryFullProcessImageNameW", GetLastError());
  path.resize(pathSize);
  Handle image(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL,
                           FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                           FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (image.value == INVALID_HANDLE_VALUE) return failure(env, "CreateFileW", GetLastError());
  BY_HANDLE_FILE_INFORMATION imageInfo;
  if (!GetFileInformationByHandle(image.value, &imageInfo))
    return failure(env, "GetFileInformationByHandle", GetLastError());
  if (imageInfo.nNumberOfLinks != 1 ||
      (imageInfo.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)))
    return failure(env, "Process image validation", ERROR_ACCESS_DENIED);
  std::wstring final, finalNt;
  if (!finalPath(env, image.value, final) || !finalNtPath(env, image.value, finalNt)) return nullptr;
  if (!windowsPathEqual(mapped.path, finalNt))
    return failure(env, "Process mapped image binding", ERROR_ACCESS_DENIED);
  bool packaged = false;
  std::wstring packageFamily;
  if (!processPackageFamily(env, process.value, packaged, packageFamily)) return nullptr;
  std::string publisherSha256;
  if (!packaged && !verifiedPublisherIdentity(env, final, image.value, publisherSha256)) return nullptr;
  if (WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT)
    return failure(env, "Process identity", ERROR_INVALID_PARAMETER);
  FILETIME createdAfter, exitedAfter, kernelAfter, userAfter;
  if (!GetProcessTimes(process.value, &createdAfter, &exitedAfter, &kernelAfter, &userAfter))
    return failure(env, "GetProcessTimes", GetLastError());
  if (createdAfter.dwHighDateTime != created.dwHighDateTime ||
      createdAfter.dwLowDateTime != created.dwLowDateTime)
    return failure(env, "Process identity", ERROR_INVALID_PARAMETER);
  std::wstring pathAfter(32768, L'\0');
  DWORD pathAfterSize = static_cast<DWORD>(pathAfter.size());
  if (!QueryFullProcessImageNameW(process.value, 0, pathAfter.data(), &pathAfterSize))
    return failure(env, "QueryFullProcessImageNameW", GetLastError());
  pathAfter.resize(pathAfterSize);
  if (CompareStringOrdinal(path.data(), static_cast<int>(path.size()),
                           pathAfter.data(), static_cast<int>(pathAfter.size()), TRUE) != CSTR_EQUAL)
    return failure(env, "Process image identity", ERROR_INVALID_PARAMETER);
  MappedImageSnapshot mappedAfter;
  if (!mainMappedImage(env, process.value, mappedAfter)) return nullptr;
  if (mappedAfter.base != mapped.base || !windowsPathEqual(mappedAfter.path, mapped.path) ||
      !windowsPathEqual(mappedAfter.path, finalNt))
    return failure(env, "Process mapped image identity", ERROR_INVALID_PARAMETER);
  bool packagedAfter = false;
  std::wstring packageFamilyAfter;
  if (!processPackageFamily(env, process.value, packagedAfter, packageFamilyAfter)) return nullptr;
  if (packagedAfter != packaged ||
      (packaged && CompareStringOrdinal(packageFamily.data(), static_cast<int>(packageFamily.size()),
                                        packageFamilyAfter.data(), static_cast<int>(packageFamilyAfter.size()),
                                        FALSE) != CSTR_EQUAL))
    return failure(env, "Process package identity", ERROR_INVALID_PARAMETER);
  ULARGE_INTEGER time; time.HighPart = created.dwHighDateTime; time.LowPart = created.dwLowDateTime;
  const std::string start = std::to_string(time.QuadPart);
  napi_value result, pathValue, mappedPathValue, identityValue, startValue, bindingValue;
  napi_create_object(env, &result);
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(path.data()), path.size(), &pathValue);
  if (packaged)
    napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(packageFamily.data()),
                             packageFamily.size(), &identityValue);
  else
    napi_create_string_utf8(env, publisherSha256.c_str(), publisherSha256.size(), &identityValue);
  napi_create_string_utf8(env, start.c_str(), start.size(), &startValue);
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(mapped.path.data()),
                           mapped.path.size(), &mappedPathValue);
  napi_create_string_utf8(env, "mapped-image-file-handle-v1", NAPI_AUTO_LENGTH, &bindingValue);
  napi_set_named_property(env, result, "executablePath", pathValue);
  napi_set_named_property(env, result, packaged ? "packageFamilyName" : "publisherSha256", identityValue);
  napi_set_named_property(env, result, "processStartTime", startValue);
  napi_set_named_property(env, result, "mappedImagePath", mappedPathValue);
  napi_set_named_property(env, result, "imageBinding", bindingValue);
  return result;
}
#include "private-append.h"
#include "process-job.h"
#include "process-spawn.h"
#include "process-detached.h"
#include "pipe-reservation.h"
#include "pipe-stream.h"
#include "skill-delete-windows.h"
#include "pipe-connect.h"
#include "pipe-accept.h"

static napi_value environmentNamesEqual(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  if (!arguments(env, info, 2, args)) return nullptr;
  std::wstring names[2];
  for (size_t i = 0; i < 2; ++i) {
    size_t length = 0;
    if (napi_get_value_string_utf16(env, args[i], nullptr, 0, &length) != napi_ok ||
        length == 0 || length > 32766) {
      napi_throw_type_error(env, "EINVAL", "Expected a nonempty Windows environment name"); return nullptr;
    }
    names[i].resize(length + 1);
    if (napi_get_value_string_utf16(env, args[i], reinterpret_cast<char16_t*>(names[i].data()),
                                  length + 1, &length) != napi_ok) {
      napi_throw_type_error(env, "EINVAL", "Cannot read Windows environment name"); return nullptr;
    }
    names[i].resize(length);
    if (names[i].find_first_of(std::wstring(L"=\0", 2)) != std::wstring::npos) {
      napi_throw_type_error(env, "EINVAL", "Invalid Windows environment name"); return nullptr;
    }
  }
  const int comparison = CompareStringOrdinal(names[0].data(), static_cast<int>(names[0].size()),
                                              names[1].data(), static_cast<int>(names[1].size()), TRUE);
  if (comparison == 0) return failure(env, "CompareStringOrdinal", GetLastError());
  napi_get_boolean(env, comparison == CSTR_EQUAL, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  if (uv_version() != UV_VERSION_HEX) {
    napi_throw_error(env, "E_SYSTEM_NATIVE_UNAVAILABLE", "Rebuild Windows native artifact for the current Node.js/libuv runtime");
    return nullptr;
  }
  napi_property_descriptor functions[] = {
    {"spawnDetached", nullptr, guarded<spawnDetached>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"connectVerifiedPipe", nullptr, guarded<connectVerifiedPipe>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"reservePipeName", nullptr, guarded<reservePipeName>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"spawnInherited", nullptr, guarded<spawnInherited>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"environmentNamesEqual", nullptr, guarded<environmentNamesEqual>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createProcessJob", nullptr, guarded<createProcessJob>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createPrivateFile", nullptr, guarded<createFile>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createTemporaryPrivateFile", nullptr, guarded<createTemporaryFile>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createPrivateDirectory", nullptr, guarded<createDirectory>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"renameDirectoryNoReplace", nullptr, guarded<renameDirectoryNoReplace>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"renameWriteThrough", nullptr, guarded<renameWriteThrough>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"hasPrivateDacl", nullptr, guarded<privateDacl>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"syncDirectory", nullptr, guarded<syncDirectory>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"deleteSkillEntry", nullptr, guarded<deleteSkillEntry>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"deletePrivateArtifact", nullptr, guarded<deletePrivateArtifact>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"processStartTime", nullptr, guarded<processStartTime>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"processExecutableIdentity", nullptr, guarded<processExecutableIdentity>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"executableFileIdentity", nullptr, guarded<executableFileIdentity>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readPrivateFile", nullptr, guarded<readPrivateFile>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openPrivateFile", nullptr, guarded<openPrivateFile>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"appendPrivateFile", nullptr, guarded<appendPrivateFile>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"protectPrivateDirectory", nullptr, guarded<protectPrivateDirectory>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"protectPrivateFile", nullptr, guarded<protectPrivateFile>, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(functions) / sizeof(functions[0]), functions);
  napi_value version; napi_create_int32(env, 1, &version);
  napi_set_named_property(env, exports, "abiVersion", version);
  return exports;
}
NAPI_MODULE(agnes_system, initialize)
