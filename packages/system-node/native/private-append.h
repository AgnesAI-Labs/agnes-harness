// Called on the Node thread with a synchronous HANDLE; no descriptor is reopened after validation.
static napi_value appendPrivateFile(napi_env env, napi_callback_info info) {
  napi_value args[3]; std::wstring path; bool buffer = false, flush = false;
  void* bytes = nullptr; size_t size = 0;
  if (!arguments(env, info, 3, args) || !stringArgument(env, args[0], path)) return nullptr;
  if (napi_is_buffer(env, args[1], &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, args[1], &bytes, &size) != napi_ok || size > MAXDWORD ||
      napi_get_value_bool(env, args[2], &flush) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "Expected an append buffer and flush flag"); return nullptr;
  }
  Local security = privateSecurity(env);
  if (!security) return nullptr;
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), security.get(), FALSE};
  Handle file(CreateFileW(path.c_str(), GENERIC_WRITE | READ_CONTROL | WRITE_DAC,
                         FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, OPEN_ALWAYS,
                         FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return failure(env, "Open private append", GetLastError());
  BY_HANDLE_FILE_INFORMATION infoFile;
  if (!GetFileInformationByHandle(file.value, &infoFile))
    return failure(env, "Private append attributes", GetLastError());
  bool valid = false;
  if (!checkPrivateDacl(env, file.value, valid, false)) return nullptr;
  if (!valid || infoFile.nNumberOfLinks != 1 ||
      (infoFile.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)))
    return failure(env, "Private append validation", ERROR_ACCESS_DENIED);
  // Preserve already-private inherited entries; never repair a broad or foreign ACL silently.
  PACL dacl = nullptr; PSECURITY_DESCRIPTOR raw = nullptr;
  DWORD status = GetSecurityInfo(file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                nullptr, nullptr, &dacl, nullptr, &raw);
  if (status != ERROR_SUCCESS) return failure(env, "Read private append ACL", status);
  Local descriptor(raw);
  status = SetSecurityInfo(file.value, SE_FILE_OBJECT,
                          DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                          nullptr, nullptr, dacl, nullptr);
  if (status != ERROR_SUCCESS) return failure(env, "Protect private append ACL", status);
  if (!checkPrivateDacl(env, file.value, valid)) return nullptr;
  if (!valid) return failure(env, "Private append validation", ERROR_ACCESS_DENIED);
  if (size) {
    OVERLAPPED offset{}; offset.Offset = MAXDWORD; offset.OffsetHigh = MAXDWORD;
    DWORD written = 0;
    if (!WriteFile(file.value, bytes, static_cast<DWORD>(size), &written, &offset))
      return failure(env, "Append private file", GetLastError());
    if (written != size) return failure(env, "Short private append", ERROR_WRITE_FAULT);
  }
  if (flush && !FlushFileBuffers(file.value)) return failure(env, "Flush private append", GetLastError());
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return nullptr;
  return result;
}
