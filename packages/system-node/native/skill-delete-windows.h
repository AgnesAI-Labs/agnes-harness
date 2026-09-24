// Pin ancestors against rename and delete the verified entry through that same handle.
static napi_value deleteSkillEntry(napi_env env, napi_callback_info info) {
  napi_value args[6];
  if (!arguments(env, info, 6, args)) return nullptr;
  std::wstring path;
  if (!stringArgument(env, args[0], path)) return nullptr;
  double expected[4] = {}; uint64_t identities[2]; bool directory;
  for (size_t i = 0; i < 2; ++i) {
    bool lossless;
    if (napi_get_value_bigint_uint64(env, args[i + 1], &identities[i], &lossless) != napi_ok || !lossless)
      return failure(env, "Skill identity", ERROR_INVALID_PARAMETER);
  }
  for (size_t i = 2; i < 4; ++i) {
    if (napi_get_value_double(env, args[i + 1], &expected[i]) != napi_ok ||
        !std::isfinite(expected[i]) || expected[i] < 0 || expected[i] > 9007199254740991.0)
      return failure(env, "Skill identity", ERROR_INVALID_PARAMETER);
  }
  if (napi_get_value_bool(env, args[5], &directory) != napi_ok ||
      path.size() < 8 || path.substr(0, 4) != L"\\\\?\\" || path[5] != L':' || path[6] != L'\\')
    return failure(env, "Skill path", ERROR_INVALID_PARAMETER);
  std::vector<std::unique_ptr<Handle>> ancestors;
  for (size_t end = 6; end < path.size(); ++end) {
    if (path[end] != L'\\') continue;
    const auto prefix = path.substr(0, end == 6 ? 7 : end);
    auto handle = std::make_unique<Handle>(CreateFileW(prefix.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    if (handle->value == INVALID_HANDLE_VALUE) return failure(env, "Skill ancestor", GetLastError());
    BY_HANDLE_FILE_INFORMATION meta;
    if (!GetFileInformationByHandle(handle->value, &meta)) return failure(env, "Skill ancestor", GetLastError());
    if (!(meta.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (meta.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
      return failure(env, "Skill ancestor", ERROR_ACCESS_DENIED);
    ancestors.push_back(std::move(handle));
  }
  Handle file(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | DELETE, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return failure(env, "Skill entry", GetLastError());
  BY_HANDLE_FILE_INFORMATION meta;
  if (!GetFileInformationByHandle(file.value, &meta)) return failure(env, "Skill identity", GetLastError());
  const uint64_t ino = (static_cast<uint64_t>(meta.nFileIndexHigh) << 32) | meta.nFileIndexLow;
  const uint64_t size = (static_cast<uint64_t>(meta.nFileSizeHigh) << 32) | meta.nFileSizeLow;
  const uint64_t ticks = (static_cast<uint64_t>(meta.ftLastWriteTime.dwHighDateTime) << 32) | meta.ftLastWriteTime.dwLowDateTime;
  const double mtime = static_cast<double>(ticks - 116444736000000000ULL) / 10000.0;
  if ((meta.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      !!(meta.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory ||
      meta.dwVolumeSerialNumber != identities[0] || ino != identities[1] ||
      (!directory && (meta.nNumberOfLinks != 1 || static_cast<double>(size) != expected[2] ||
                     std::abs(mtime - expected[3]) > 0.001)))
    return failure(env, "Skill identity", ERROR_ACCESS_DENIED);
  FILE_DISPOSITION_INFO disposition = { TRUE };
  if (!SetFileInformationByHandle(file.value, FileDispositionInfo, &disposition, sizeof(disposition)))
    return failure(env, "Skill delete", GetLastError());
  napi_value result; napi_get_undefined(env, &result); return result;
}
