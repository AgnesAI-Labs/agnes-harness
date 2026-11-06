// Write-restricted launch for the process broker, which its Host has already assigned to the
// command's Job. The target is created suspended with a restricted Low integrity token, so it is a
// member of that Job before any of its code runs, and it stays suspended until resume(). It gets
// exactly the broker's three standard handles and shares the broker's hidden console.
// Included by windows.cc after process-detached.h and windows-acl.h, whose environment block and
// SID helpers it reuses.
//
// The token (write-restricted, with the logon SID and Everyone in the restricting list next to the
// write SIDs; Low integrity; a default DACL entry for a restricting SID so the target can still
// create pipes and other objects) follows the write-restricted ACL backend of DeepSeek Harness
// (packages/sandbox/sandbox-windows-acl), MIT License, Copyright (c) 2026 DeepSeek; see
// DEEPSEEK-LICENSE.txt in this directory.
static const napi_type_tag restrictedProcessTag = {0x1f7c9b2e64a84d0bULL, 0xa36e05d1c8f24b97ULL};
struct RestrictedProcess {
  HANDLE process = nullptr;
  HANDLE thread = nullptr;  // Held only while the target is suspended.
  ~RestrictedProcess() {
    if (thread) { TerminateProcess(process, 1); CloseHandle(thread); }
    if (process) CloseHandle(process);
  }
};
// A target that was never resumed has run none of its code; end it before releasing the thread.
static void restrictedDiscard(RestrictedProcess* target) {
  if (!target->thread) return;
  TerminateProcess(target->process, 1);
  CloseHandle(target->thread);
  target->thread = nullptr;
}
static RestrictedProcess* restrictedReceiver(napi_env env, napi_callback_info info) {
  napi_value receiver; size_t count = 0; bool tagged = false; void* data = nullptr;
  if (napi_get_cb_info(env, info, &count, nullptr, &receiver, nullptr) != napi_ok ||
      napi_check_object_type_tag(env, receiver, &restrictedProcessTag, &tagged) != napi_ok ||
      !tagged || napi_unwrap(env, receiver, &data) != napi_ok || !data) {
    napi_throw_type_error(env, "EINVAL", "Invalid restricted process receiver"); return nullptr;
  }
  auto* target = static_cast<RestrictedProcess*>(data);
  if (target->process) return target;
  napi_throw_error(env, "E_PROCESS_CLOSED", "Restricted process handle is closed"); return nullptr;
}
static napi_value restrictedResume(napi_env env, napi_callback_info info) {
  auto* target = restrictedReceiver(env, info);
  if (!target) return nullptr;
  if (!target->thread) {
    napi_throw_error(env, "E_PROCESS_RESUMED", "Restricted process is not suspended"); return nullptr;
  }
  if (injectedFault(L"resume") || ResumeThread(target->thread) == static_cast<DWORD>(-1)) {
    const DWORD cause = GetLastError();
    restrictedDiscard(target);
    return failure(env, "ResumeThread restricted", cause);
  }
  CloseHandle(target->thread);
  target->thread = nullptr;
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value restrictedExitCode(napi_env env, napi_callback_info info) {
  auto* target = restrictedReceiver(env, info);
  if (!target) return nullptr;
  napi_value result;
  const DWORD state = WaitForSingleObject(target->process, 0);
  if (state == WAIT_TIMEOUT) { napi_get_null(env, &result); return result; }
  if (state != WAIT_OBJECT_0) return failure(env, "WaitForSingleObject restricted", GetLastError());
  DWORD code;
  if (!GetExitCodeProcess(target->process, &code)) return failure(env, "GetExitCodeProcess restricted", GetLastError());
  napi_create_uint32(env, code, &result); return result;
}
// Idempotent. Ends a target that was never resumed; a running one stays with its Job.
static napi_value restrictedClose(napi_env env, napi_callback_info info) {
  napi_value receiver; size_t count = 0; bool tagged = false; void* data = nullptr;
  if (napi_get_cb_info(env, info, &count, nullptr, &receiver, nullptr) != napi_ok ||
      napi_check_object_type_tag(env, receiver, &restrictedProcessTag, &tagged) != napi_ok ||
      !tagged || napi_unwrap(env, receiver, &data) != napi_ok || !data) {
    napi_throw_type_error(env, "EINVAL", "Invalid restricted process receiver"); return nullptr;
  }
  auto* target = static_cast<RestrictedProcess*>(data);
  restrictedDiscard(target);
  if (target->process) {
    const BOOL closed = CloseHandle(target->process);
    target->process = nullptr;
    if (!closed) return failure(env, "CloseHandle restricted", GetLastError());
  }
  napi_value result; napi_get_undefined(env, &result); return result;
}
static void finalizeRestricted(napi_env, void* data, void*) { delete static_cast<RestrictedProcess*>(data); }

static bool restrictedTokenInformation(napi_env env, HANDLE token, TOKEN_INFORMATION_CLASS type,
                                       std::vector<BYTE>& data) {
  DWORD size = 0;
  GetTokenInformation(token, type, nullptr, 0, &size);  // Sizes the buffer; fails by design.
  if (!size) { failure(env, "GetTokenInformation restricted", GetLastError()); return false; }
  data.assign(size, 0);
  if (!GetTokenInformation(token, type, data.data(), size, &size)) {
    failure(env, "GetTokenInformation restricted", GetLastError()); return false;
  }
  return true;
}
// Read-only: no write SID. Writing: the workspace grant's SID, then optionally the temp grant's.
static bool restrictedWriteSids(napi_env env, napi_value list, napi_value mode, std::vector<std::vector<BYTE>>& out) {
  bool array = false, readOnly = false;
  uint32_t count = 0;
  if (napi_get_value_bool(env, mode, &readOnly) != napi_ok || napi_is_array(env, list, &array) != napi_ok ||
      !array || napi_get_array_length(env, list, &count) != napi_ok ||
      (readOnly ? count != 0 : (count < 1 || count > 2))) {
    napi_throw_type_error(env, "EINVAL", "Expected the write SIDs of a restricted launch"); return false;
  }
  for (uint32_t i = 0; i < count; ++i) {
    napi_value entry;
    std::wstring text;
    std::vector<BYTE> sid;
    if (napi_get_element(env, list, i, &entry) != napi_ok) {
      napi_throw_type_error(env, "EINVAL", "Cannot read a restricted launch write SID"); return false;
    }
    if (!stringArgument(env, entry, text)) return false;
    if (!aclCapabilitySid(text, sid) || std::find(out.begin(), out.end(), sid) != out.end()) {
      napi_throw_type_error(env, "EINVAL", "Expected distinct capability SIDs (S-1-4-...)"); return false;
    }
    out.push_back(std::move(sid));
  }
  return true;
}
// A primary token that may write only where an allow entry names the logon session, Everyone, a
// write SID or this launch's isolation SID (as well as the user), at Low integrity, without
// privileges beyond change notification.
static bool restrictedToken(napi_env env, std::vector<std::vector<BYTE>>& writeSids, std::vector<BYTE>& isolation,
                            Handle& out) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(),
                        TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &raw)) {
    failure(env, "OpenProcessToken restricted", GetLastError()); return false;
  }
  Handle current(raw);
  std::vector<BYTE> groups;
  if (!restrictedTokenInformation(env, raw, TokenGroups, groups)) return false;
  const auto* list = reinterpret_cast<const TOKEN_GROUPS*>(groups.data());
  PSID logon = nullptr;
  for (DWORD i = 0; i < list->GroupCount && !logon; ++i)
    if ((list->Groups[i].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) logon = list->Groups[i].Sid;
  if (!logon) {
    napi_throw_error(env, "E_WINDOWS_LOGON_SID", "The current token has no logon session SID"); return false;
  }
  std::vector<BYTE> everyone, low;
  if (!aclWellKnownSid(WinWorldSid, everyone) || !aclWellKnownSid(WinLowLabelSid, low)) {
    failure(env, "CreateWellKnownSid restricted", GetLastError()); return false;
  }
  // The restricting list only decides writes (the token is write-restricted; reads are checked as
  // usual). The logon SID and Everyone stay in it because the target's own startup writes objects
  // whose DACLs name only them: the console connection and the window station and desktop of the
  // logon session name the logon SID, and devices such as \Device\CNG and the session's named
  // object directories grant Everyone. Without them early DLL initialization and CNG fail in the
  // target. They do not open one confined process to another: no object a confined process
  // creates names either of them for writing (see the default DACL below), and a grant refuses a
  // workspace where an entry gives either of them a write right (aclBroadWrite).
  std::vector<SID_AND_ATTRIBUTES> restricting = {{logon, 0}, {everyone.data(), 0}, {isolation.data(), 0}};
  for (auto& sid : writeSids) restricting.push_back({sid.data(), 0});
  HANDLE restricted = nullptr;
  if (injectedFault(L"token") ||
      !CreateRestrictedToken(raw, DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED, 0, nullptr, 0, nullptr,
                             static_cast<DWORD>(restricting.size()), restricting.data(), &restricted)) {
    failure(env, "CreateRestrictedToken", GetLastError()); return false;
  }
  out.value = restricted;
  // The process, its threads and every object the target creates without an inherited DACL
  // (pipes for its own children, events, sections) take the default DACL, and so do the objects of
  // its descendants, which inherit this token. Its user entry passes the normal access check, so
  // the restricting SIDs decide who may write such an object. Only this launch's isolation SID gets
  // an entry: the target and its descendants hold it and no other process does, so another
  // confined process (another session, a read-only one, another workspace) cannot open them for
  // writing, injecting code or duplicating their handles. Any entry the default DACL already has
  // for the logon SID or Everyone, which every confined token holds, is removed.
  std::vector<BYTE> defaults;
  if (!restrictedTokenInformation(env, restricted, TokenDefaultDacl, defaults)) return false;
  PACL dacl = reinterpret_cast<const TOKEN_DEFAULT_DACL*>(defaults.data())->DefaultDacl;
  if (!dacl) { failure(env, "TokenDefaultDacl restricted", ERROR_INVALID_ACL); return false; }
  EXPLICIT_ACCESSW entries[3] = {};
  const PSID trustees[3] = {logon, everyone.data(), isolation.data()};
  for (int i = 0; i < 3; ++i) {
    entries[i].grfAccessPermissions = i == 2 ? GENERIC_ALL : 0;
    entries[i].grfAccessMode = i == 2 ? GRANT_ACCESS : REVOKE_ACCESS;
    entries[i].grfInheritance = NO_INHERITANCE;
    entries[i].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entries[i].Trustee.TrusteeType = TRUSTEE_IS_GROUP;
    entries[i].Trustee.ptstrName = static_cast<LPWSTR>(trustees[i]);
  }
  PACL merged = nullptr;
  const DWORD merge = SetEntriesInAclW(3, entries, dacl, &merged);
  if (merge != ERROR_SUCCESS) { failure(env, "SetEntriesInAcl restricted", merge); return false; }
  Local mergedOwner(merged);
  TOKEN_DEFAULT_DACL value = {merged};
  if (injectedFault(L"dacl") || !SetTokenInformation(restricted, TokenDefaultDacl, &value, sizeof(value))) {
    failure(env, "SetTokenInformation default DACL", GetLastError()); return false;
  }
  TOKEN_MANDATORY_LABEL label = {};
  label.Label.Sid = low.data();
  label.Label.Attributes = SE_GROUP_INTEGRITY;
  if (injectedFault(L"label") ||
      !SetTokenInformation(restricted, TokenIntegrityLevel, &label, static_cast<DWORD>(sizeof(label) + low.size()))) {
    failure(env, "SetTokenInformation integrity", GetLastError()); return false;
  }
  return true;
}

struct RestrictedAttributes {
  RestrictedAttributes() = default;
  RestrictedAttributes(const RestrictedAttributes&) = delete;
  RestrictedAttributes& operator=(const RestrictedAttributes&) = delete;
  ~RestrictedAttributes() { if (list) DeleteProcThreadAttributeList(list); }
  std::vector<BYTE> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
};
// Inheritable copies of this gate's standard handles, and an attribute list that limits
// inheritance to exactly those copies, so no other handle of this process reaches the target.
static bool restrictedStdio(napi_env env, std::vector<std::unique_ptr<Handle>>& copies, HANDLE (&handles)[3],
                            RestrictedAttributes& attributes) {
  for (int fd = 0; fd < 3; ++fd) {
    const HANDLE source = uv_get_osfhandle(fd);
    if (!source || source == INVALID_HANDLE_VALUE) {
      failure(env, "standard handle for restricted launch", ERROR_INVALID_HANDLE); return false;
    }
    HANDLE copy = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)) {
      failure(env, "DuplicateHandle restricted", GetLastError()); return false;
    }
    copies.push_back(std::make_unique<Handle>(copy));
    handles[fd] = copy;
  }
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &size);  // Sizes the list; fails by design.
  if (!size) { failure(env, "InitializeProcThreadAttributeList", GetLastError()); return false; }
  attributes.storage.assign(size, 0);
  auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.storage.data());
  if (!InitializeProcThreadAttributeList(list, 1, 0, &size)) {
    failure(env, "InitializeProcThreadAttributeList", GetLastError()); return false;
  }
  attributes.list = list;
  if (injectedFault(L"stdio") ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr)) {
    failure(env, "UpdateProcThreadAttribute handle list", GetLastError()); return false;
  }
  return true;
}

// (application, commandLine, cwd, environment block, writeSids, readOnly, isolationSid)
// -> suspended target.
static napi_value spawnRestricted(napi_env env, napi_callback_info info) {
  napi_value args[7];
  if (!arguments(env, info, 7, args)) return nullptr;
  std::wstring application, commandLine, cwd, environment;
  if (!stringArgument(env, args[0], application) || !stringArgument(env, args[1], commandLine) ||
      !stringArgument(env, args[2], cwd) || !detachedEnvironment(env, args[3], environment)) return nullptr;
  if (!detachedAbsolute(application) || !detachedAbsolute(cwd)) {
    napi_throw_type_error(env, "EINVAL", "Restricted executable and cwd must be absolute"); return nullptr;
  }
  std::vector<std::vector<BYTE>> writeSids;
  if (!restrictedWriteSids(env, args[4], args[5], writeSids)) return nullptr;
  // A fresh capability SID per launch, never one of the grants' SIDs.
  std::wstring isolationText;
  std::vector<BYTE> isolation;
  if (!stringArgument(env, args[6], isolationText)) return nullptr;
  if (!aclCapabilitySid(isolationText, isolation) || std::find(writeSids.begin(), writeSids.end(), isolation) != writeSids.end()) {
    napi_throw_type_error(env, "EINVAL", "Expected a distinct isolation SID (S-1-4-...)"); return nullptr;
  }
  auto owner = std::make_unique<RestrictedProcess>();
  napi_value result;
  const napi_property_descriptor methods[] = {
    {"resume", nullptr, guarded<restrictedResume>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"exitCode", nullptr, guarded<restrictedExitCode>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, guarded<restrictedClose>, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_create_object(env, &result) != napi_ok ||
      napi_type_tag_object(env, result, &restrictedProcessTag) != napi_ok ||
      napi_define_properties(env, result, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok ||
      napi_wrap(env, result, owner.get(), finalizeRestricted, nullptr, nullptr) != napi_ok) {
    napi_throw_error(env, "E_NATIVE_FAILURE", "Cannot initialize restricted process object"); return nullptr;
  }
  auto* target = owner.release();  // The result's finalizer owns it from here, even on failure.
  Handle token(nullptr);
  if (!restrictedToken(env, writeSids, isolation, token)) return nullptr;
  std::vector<std::unique_ptr<Handle>> copies;
  HANDLE handles[3] = {};
  RestrictedAttributes attributes;
  if (!restrictedStdio(env, copies, handles, attributes)) return nullptr;
  STARTUPINFOEXW startup = {};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = handles[0];
  startup.StartupInfo.hStdOutput = handles[1];
  startup.StartupInfo.hStdError = handles[2];
  startup.lpAttributeList = attributes.list;
  PROCESS_INFORMATION child = {};
  // No console flag: a restricted target that must create its own console fails to initialize, so
  // it attaches to this gate's hidden console, and its own console descendants do the same.
  if (injectedFault(L"create") ||
      !CreateProcessAsUserW(token.value, application.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
                            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                            environment.data(), cwd.c_str(), &startup.StartupInfo, &child))
    return failure(env, "CreateProcessAsUserW", GetLastError());
  target->process = child.hProcess;
  target->thread = child.hThread;  // From here the target is ended unless it is resumed.
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(child.hProcess, &created, &exited, &kernel, &user)) {
    const DWORD cause = GetLastError();
    restrictedDiscard(target);
    return failure(env, "GetProcessTimes restricted", cause);
  }
  ULARGE_INTEGER time; time.HighPart = created.dwHighDateTime; time.LowPart = created.dwLowDateTime;
  const std::string start = std::to_string(time.QuadPart);
  napi_value pid, startTime;
  if (napi_create_uint32(env, child.dwProcessId, &pid) != napi_ok ||
      napi_set_named_property(env, result, "pid", pid) != napi_ok ||
      napi_create_string_utf8(env, start.c_str(), start.size(), &startTime) != napi_ok ||
      napi_set_named_property(env, result, "startTime", startTime) != napi_ok) {
    restrictedDiscard(target);
    napi_throw_error(env, "E_NATIVE_FAILURE", "Cannot publish restricted process identity"); return nullptr;
  }
  return result;
}
