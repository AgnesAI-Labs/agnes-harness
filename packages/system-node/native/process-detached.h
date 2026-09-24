// Included after windows.cc's shared error, N-API and handle helpers.
static const napi_type_tag detachedProcessTag = {0x64c2a9f532904f28ULL, 0xb815d72e739c4061ULL};
struct DetachedProcess {
  HANDLE handle = nullptr;
  ~DetachedProcess() { if (handle) CloseHandle(handle); }
};
static DetachedProcess* detachedReceiver(napi_env env, napi_callback_info info) {
  napi_value receiver; size_t count = 0; bool tagged = false; void* data = nullptr;
  if (napi_get_cb_info(env, info, &count, nullptr, &receiver, nullptr) != napi_ok ||
      napi_check_object_type_tag(env, receiver, &detachedProcessTag, &tagged) != napi_ok ||
      !tagged || napi_unwrap(env, receiver, &data) != napi_ok || !data) {
    napi_throw_type_error(env, "EINVAL", "Invalid detached process receiver"); return nullptr;
  }
  return static_cast<DetachedProcess*>(data);
}
static bool detachedOpen(napi_env env, DetachedProcess* process) {
  if (!process) return false;
  if (process->handle) return true;
  napi_throw_error(env, "E_PROCESS_CLOSED", "Detached process handle is closed"); return false;
}
static napi_value detachedExitCode(napi_env env, napi_callback_info info) {
  auto* process = detachedReceiver(env, info);
  if (!detachedOpen(env, process)) return nullptr;
  napi_value result;
  const DWORD state = WaitForSingleObject(process->handle, 0);
  if (state == WAIT_TIMEOUT) { napi_get_null(env, &result); return result; }
  if (state != WAIT_OBJECT_0) return failure(env, "WaitForSingleObject detached", GetLastError());
  DWORD code;
  if (!GetExitCodeProcess(process->handle, &code)) return failure(env, "GetExitCodeProcess", GetLastError());
  napi_create_uint32(env, code, &result); return result;
}
static napi_value detachedTerminate(napi_env env, napi_callback_info info) {
  auto* process = detachedReceiver(env, info);
  if (!detachedOpen(env, process)) return nullptr;
  const DWORD state = WaitForSingleObject(process->handle, 0);
  if (state != WAIT_OBJECT_0 && state != WAIT_TIMEOUT)
    return failure(env, "WaitForSingleObject detached terminate", GetLastError());
  if (state == WAIT_TIMEOUT && !TerminateProcess(process->handle, 1)) {
    const DWORD cause = GetLastError();
    if (WaitForSingleObject(process->handle, 0) != WAIT_OBJECT_0)
      return failure(env, "TerminateProcess detached", cause);
  }
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value detachedClose(napi_env env, napi_callback_info info) {
  auto* process = detachedReceiver(env, info);
  if (!process) return nullptr;
  if (process->handle) {
    if (!CloseHandle(process->handle)) return failure(env, "CloseHandle detached", GetLastError());
    process->handle = nullptr;
  }
  napi_value result; napi_get_undefined(env, &result); return result;
}
static void finalizeDetached(napi_env, void* data, void*) { delete static_cast<DetachedProcess*>(data); }
static bool detachedAbsolute(const std::wstring& path) {
  const auto slash = [](wchar_t c) { return c == L'\\' || c == L'/'; };
  return (path.size() > 2 && ((path[0] >= L'A' && path[0] <= L'Z') ||
          (path[0] >= L'a' && path[0] <= L'z')) && path[1] == L':' && slash(path[2])) ||
         (path.size() > 3 && slash(path[0]) && slash(path[1]) && !slash(path[2]));
}
static bool detachedEnvironment(napi_env env, napi_value value, std::wstring& block) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok ||
      length < 2 || length > 1048576) {
    napi_throw_type_error(env, "EINVAL", "Invalid detached environment block length"); return false;
  }
  block.resize(length + 1);
  if (napi_get_value_string_utf16(env, value, reinterpret_cast<char16_t*>(block.data()),
                                length + 1, &length) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "Cannot read detached environment"); return false;
  }
  block.resize(length);
  bool valid = block[length - 1] == L'\0' && block[length - 2] == L'\0';
  if (length != 2 || block[0] != L'\0') {
    for (size_t at = 0; valid && at < length - 1;) {
      const size_t end = block.find(L'\0', at);
      const size_t equal = block.find(L'=', at);
      valid = end != std::wstring::npos && end > at && equal > at && equal < end;
      if (valid) at = end + 1;
    }
  }
  if (!valid) napi_throw_type_error(env, "EINVAL", "Invalid detached environment block");
  if (valid && length > 2) {
    std::vector<std::wstring> entries;
    for (size_t at = 0; at < length - 1;) {
      const size_t end = block.find(L'\0', at);
      entries.push_back(block.substr(at, end - at)); at = end + 1;
    }
    std::sort(entries.begin(), entries.end(), [](const std::wstring& a, const std::wstring& b) {
      const int order = CompareStringOrdinal(a.data(), static_cast<int>(a.find(L'=')),
                                             b.data(), static_cast<int>(b.find(L'=')), TRUE);
      if (!order) throw ERROR_INVALID_DATA;
      return order == CSTR_LESS_THAN;
    });
    block.clear();
    for (const auto& entry : entries) { block.append(entry); block.push_back(L'\0'); }
    block.push_back(L'\0');
  }
  return valid;
}
static napi_value spawnDetached(napi_env env, napi_callback_info info) {
  napi_value args[4];
  if (!arguments(env, info, 4, args)) return nullptr;
  std::wstring executable, command, cwd, environment;
  if (!stringArgument(env, args[0], executable) || !stringArgument(env, args[1], command) ||
      !stringArgument(env, args[2], cwd) || !detachedEnvironment(env, args[3], environment)) return nullptr;
  if (!detachedAbsolute(executable) || !detachedAbsolute(cwd)) {
    napi_throw_type_error(env, "EINVAL", "Detached executable and cwd must be absolute"); return nullptr;
  }
  auto owner = std::make_unique<DetachedProcess>();
  napi_value result;
  const napi_property_descriptor methods[] = {
    {"exitCode", nullptr, guarded<detachedExitCode>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"terminate", nullptr, guarded<detachedTerminate>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, guarded<detachedClose>, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_create_object(env, &result) != napi_ok ||
      napi_type_tag_object(env, result, &detachedProcessTag) != napi_ok ||
      napi_define_properties(env, result, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok ||
      napi_wrap(env, result, owner.get(), finalizeDetached, nullptr, nullptr) != napi_ok) {
    napi_throw_error(env, "E_NATIVE_FAILURE", "Cannot initialize detached process object"); return nullptr;
  }
  auto* owned = owner.release(); // The result/finalizer now owns the object, even on spawn failure.
  STARTUPINFOW startup = {}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION child = {};
  if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE,
                      DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                      environment.data(), cwd.c_str(), &startup, &child))
    return failure(env, "CreateProcessW detached", GetLastError());
  Handle process(child.hProcess), thread(child.hThread);
  // No business code runs until every fallible JS-object operation has completed.
  napi_value pid;
  if (napi_create_uint32(env, child.dwProcessId, &pid) != napi_ok ||
      napi_set_named_property(env, result, "pid", pid) != napi_ok) {
    TerminateProcess(process.value, 1);
    napi_throw_error(env, "E_NATIVE_FAILURE", "Cannot publish detached process identity"); return nullptr;
  }
  if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) {
    const DWORD cause = GetLastError(); TerminateProcess(process.value, 1);
    return failure(env, "ResumeThread detached", cause);
  }
  owned->handle = process.value; process.value = nullptr;
  return result;
}
