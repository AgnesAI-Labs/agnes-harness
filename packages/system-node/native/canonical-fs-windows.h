// Parents remain replacement-locked until the operation ends; reparse points never participate in
// traversal. Enumeration/deletion run in Node's worker pool rather than on the JS event loop.
#include <winioctl.h>
#include <cstring>

static size_t canonicalRootEnd(const std::wstring& path) {
  if (path.size() >= 7 && path.compare(0, 4, L"\\\\?\\") == 0 && path[5] == L':' && path[6] == L'\\') return 7;
  if (path.compare(0, 8, L"\\\\?\\UNC\\") == 0) {
    size_t server = path.find(L'\\', 8);
    if (server == std::wstring::npos || server == 8) return 0;
    size_t share = path.find(L'\\', server + 1);
    return share == std::wstring::npos ? path.size() : share + 1;
  }
  return 0;
}
static DWORD canonicalHold(const std::wstring& path, bool leafDirectory, bool create,
                           std::vector<std::unique_ptr<Handle>>& held) {
  size_t root = canonicalRootEnd(path);
  if (!root) return ERROR_INVALID_NAME;
  size_t limit = leafDirectory ? path.size() : path.find_last_of(L'\\');
  if (limit < root) limit = root;
  for (size_t end = root; end <= limit;) {
    std::wstring prefix = path.substr(0, end);
    if (create && end > root && !CreateDirectoryW(prefix.c_str(), nullptr)) {
      DWORD error = GetLastError();
      if (error != ERROR_ALREADY_EXISTS) return error;
    }
    auto handle = std::make_unique<Handle>(CreateFileW(prefix.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    BY_HANDLE_FILE_INFORMATION meta{};
    if (handle->value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(handle->value, &meta)) return GetLastError();
    if (meta.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return ERROR_ACCESS_DENIED;
    if (!(meta.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
      return create && end == limit ? ERROR_ALREADY_EXISTS : ERROR_DIRECTORY;
    held.push_back(std::move(handle));
    if (end == limit) break;
    size_t next = path.find(L'\\', end + (end == root ? 0 : 1));
    end = next == std::wstring::npos || next > limit ? limit : next;
    if (end == root) return ERROR_INVALID_NAME;
  }
  return ERROR_SUCCESS;
}
static napi_value openCanonicalWritableFile(napi_env env, napi_callback_info info) {
  napi_value args[1]; std::wstring path;
  if (!arguments(env, info, 1, args) || !stringArgument(env, args[0], path)) return nullptr;
  std::vector<std::unique_ptr<Handle>> held;
  DWORD error = canonicalHold(path, false, false, held);
  if (error) return failure(env, "open canonical parent", error);
  Handle file(CreateFileW(path.c_str(), GENERIC_WRITE | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  BY_HANDLE_FILE_INFORMATION meta{};
  if (file.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(file.value, &meta)) {
    error = GetLastError();
    // OPEN_ALWAYS on a directory reports access denied. Observe the leaf without following it
    // while the parents are held, so the public file contract retains EISDIR.
    Handle leaf(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    if (leaf.value != INVALID_HANDLE_VALUE && GetFileInformationByHandle(leaf.value, &meta) &&
        (meta.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(meta.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
      napi_throw_error(env, "EISDIR", "Regular writable file required"); return nullptr;
    }
    return failure(env, "open canonical writable file", error);
  }
  if (meta.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return failure(env, "real file required", ERROR_ACCESS_DENIED);
  if (meta.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) { napi_throw_error(env, "EISDIR", "Regular writable file required"); return nullptr; }
  return adoptFile(env, file);
}
static std::wstring canonicalDisplayPath(std::wstring path) {
  if (path.compare(0, 8, L"\\\\?\\UNC\\") == 0) return L"\\\\" + path.substr(8);
  if (path.compare(0, 4, L"\\\\?\\") == 0 || path.compare(0, 4, L"\\??\\") == 0) {
    path = path.substr(4);
    if (path.compare(0, 4, L"UNC\\") == 0) path = L"\\\\" + path.substr(4);
  }
  return path;
}
static DWORD canonicalLink(HANDLE handle, std::wstring& target) {
  std::vector<BYTE> bytes(MAXIMUM_REPARSE_DATA_BUFFER_SIZE); DWORD count = 0;
  if (!DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, nullptr, 0, bytes.data(),
                       static_cast<DWORD>(bytes.size()), &count, nullptr)) return GetLastError();
  if (count < 16) return ERROR_INVALID_DATA;
  DWORD tag; USHORT offset, length;
  memcpy(&tag, bytes.data(), sizeof(tag));
  memcpy(&offset, bytes.data() + 8, sizeof(offset));
  memcpy(&length, bytes.data() + 10, sizeof(length));
  size_t start = tag == IO_REPARSE_TAG_SYMLINK ? 20 : tag == IO_REPARSE_TAG_MOUNT_POINT ? 16 : 0;
  if (!start || (offset % 2) || (length % 2) || start + offset + length > count) return ERROR_ACCESS_DENIED;
  target.resize(length / sizeof(wchar_t));
  memcpy(target.data(), bytes.data() + start + offset, length);
  target = canonicalDisplayPath(target);
  return ERROR_SUCCESS;
}
struct CanonicalWindowsEntry { std::wstring name; DWORD attributes; };
class CanonicalSearch {
 public: HANDLE value;
  explicit CanonicalSearch(HANDLE handle) : value(handle) {}
  ~CanonicalSearch() { if (value != INVALID_HANDLE_VALUE) FindClose(value); }
};
static DWORD canonicalEnumerate(const std::wstring& path, std::vector<CanonicalWindowsEntry>& entries) {
  WIN32_FIND_DATAW entry{};
  CanonicalSearch search(FindFirstFileW((path + L"\\*").c_str(), &entry));
  if (search.value == INVALID_HANDLE_VALUE) {
    DWORD error = GetLastError(); return error == ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : error;
  }
  do {
    if (!wcscmp(entry.cFileName, L".") || !wcscmp(entry.cFileName, L"..")) continue;
    entries.push_back({entry.cFileName, entry.dwFileAttributes});
  } while (FindNextFileW(search.value, &entry));
  DWORD error = GetLastError(); return error == ERROR_NO_MORE_FILES ? ERROR_SUCCESS : error;
}
static DWORD canonicalDelete(const std::wstring& path, bool recursive, bool& directoryRefused, unsigned depth = 0) {
  if (depth >= 256) return ERROR_STACK_OVERFLOW;
  Handle file(CreateFileW(path.c_str(), DELETE | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  BY_HANDLE_FILE_INFORMATION meta{};
  if (file.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(file.value, &meta)) return GetLastError();
  if ((meta.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(meta.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    if (!recursive) { directoryRefused = true; return ERROR_ACCESS_DENIED; }
    std::vector<CanonicalWindowsEntry> entries;
    DWORD error = canonicalEnumerate(path, entries);
    if (error) return error;
    for (const auto& entry : entries) {
      error = canonicalDelete(path + L"\\" + entry.name, true, directoryRefused, depth + 1);
      if (error && error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) return error;
    }
  }
  FILE_DISPOSITION_INFO disposition{TRUE};
  if (!SetFileInformationByHandle(file.value, FileDispositionInfo, &disposition, sizeof(disposition))) return GetLastError();
  return ERROR_SUCCESS;
}
struct CanonicalWindowsJob {
  napi_async_work work = nullptr; napi_deferred deferred = nullptr;
  std::wstring operation, path, text; bool recursive = false, directoryRefused = false;
  DWORD error = ERROR_SUCCESS; BY_HANDLE_FILE_INFORMATION meta{};
  std::vector<CanonicalWindowsEntry> entries;
};
static void canonicalWindowsExecute(napi_env env, void* data) {
  (void)env; auto* job = static_cast<CanonicalWindowsJob*>(data);
  try {
    std::vector<std::unique_ptr<Handle>> held;
    bool directory = job->operation == L"list" || job->operation == L"mkdir";
    job->error = canonicalHold(job->path, directory, job->operation == L"mkdir", held);
    if (job->error || job->operation == L"mkdir") return;
    if (job->operation == L"list") { job->error = canonicalEnumerate(job->path, job->entries); return; }
    if (job->operation == L"rm") { job->error = canonicalDelete(job->path, job->recursive, job->directoryRefused); return; }
    Handle file(CreateFileW(job->path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    if (file.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(file.value, &job->meta)) {
      job->error = GetLastError(); return;
    }
    bool link = (job->meta.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    if (job->operation == L"readlink" || (job->operation == L"stat" && link)) {
      job->error = canonicalLink(file.value, job->text); return;
    }
    if (job->operation == L"finalPath") {
      if (link) { job->error = ERROR_ACCESS_DENIED; return; }
      DWORD size = GetFinalPathNameByHandleW(file.value, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
      if (!size) { job->error = GetLastError(); return; }
      std::wstring text(size + 1, L'\0');
      DWORD length = GetFinalPathNameByHandleW(file.value, text.data(), size + 1, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
      if (!length || length > size) { job->error = ERROR_INVALID_DATA; return; }
      text.resize(length); job->text = canonicalDisplayPath(text);
    }
  } catch (const std::bad_alloc&) { job->error = ERROR_NOT_ENOUGH_MEMORY; }
    catch (...) { job->error = ERROR_INVALID_DATA; }
}
static const char* canonicalWindowsKind(DWORD attributes) {
  return attributes & FILE_ATTRIBUTE_REPARSE_POINT ? "symlink" : attributes & FILE_ATTRIBUTE_DIRECTORY ? "dir" : "file";
}
static void canonicalWindowsString(napi_env env, napi_value object, const char* key, const char* text) {
  napi_value value; napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, object, key, value);
}
static napi_value canonicalWindowsText(napi_env env, const std::wstring& text) {
  napi_value value; napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(text.data()), text.size(), &value); return value;
}
static void canonicalWindowsComplete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<CanonicalWindowsJob> job(static_cast<CanonicalWindowsJob*>(data)); napi_value result;
  if (status != napi_ok && !job->error) job->error = ERROR_OPERATION_ABORTED;
  if (job->error) {
    failure(env, "canonical filesystem operation", job->error); napi_get_and_clear_last_exception(env, &result);
    if (job->directoryRefused) canonicalWindowsString(env, result, "code", "ERR_FS_EISDIR");
    napi_reject_deferred(env, job->deferred, result);
  } else {
    if (job->operation == L"stat") {
      napi_create_object(env, &result);
      canonicalWindowsString(env, result, "kind", canonicalWindowsKind(job->meta.dwFileAttributes));
      napi_value value;
      double size = static_cast<double>((static_cast<ULONGLONG>(job->meta.nFileSizeHigh) << 32) | job->meta.nFileSizeLow);
      napi_create_double(env, size, &value); napi_set_named_property(env, result, "size", value);
      ULARGE_INTEGER time{}; time.LowPart = job->meta.ftLastWriteTime.dwLowDateTime; time.HighPart = job->meta.ftLastWriteTime.dwHighDateTime;
      napi_create_double(env, static_cast<double>(time.QuadPart / 10000) - 11644473600000.0, &value); napi_set_named_property(env, result, "mtimeMs", value);
      if (!job->text.empty()) napi_set_named_property(env, result, "linkTarget", canonicalWindowsText(env, job->text));
    } else if (job->operation == L"list") {
      napi_create_array_with_length(env, job->entries.size(), &result);
      for (size_t index = 0; index < job->entries.size(); index++) {
        napi_value entry; napi_create_object(env, &entry);
        napi_set_named_property(env, entry, "name", canonicalWindowsText(env, job->entries[index].name));
        canonicalWindowsString(env, entry, "kind", canonicalWindowsKind(job->entries[index].attributes));
        napi_set_element(env, result, static_cast<uint32_t>(index), entry);
      }
    } else if (job->operation == L"readlink" || job->operation == L"finalPath") result = canonicalWindowsText(env, job->text);
    else napi_get_undefined(env, &result);
    napi_resolve_deferred(env, job->deferred, result);
  }
  napi_delete_async_work(env, job->work);
}
static napi_value canonicalFs(napi_env env, napi_callback_info info) {
  napi_value args[4], promise, resource;
  auto job = std::make_unique<CanonicalWindowsJob>(); uint32_t mode;
  if (!arguments(env, info, 4, args) || !stringArgument(env, args[0], job->operation) || !stringArgument(env, args[1], job->path)) return nullptr;
  if (napi_get_value_bool(env, args[2], &job->recursive) != napi_ok || napi_get_value_uint32(env, args[3], &mode) != napi_ok || mode > 0777 ||
      (job->operation != L"stat" && job->operation != L"list" && job->operation != L"readlink" && job->operation != L"finalPath" && job->operation != L"mkdir" && job->operation != L"rm"))
    return failure(env, "canonical arguments", ERROR_INVALID_PARAMETER);
  napi_create_string_utf8(env, "canonical filesystem", NAPI_AUTO_LENGTH, &resource);
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok || napi_create_async_work(env, nullptr, resource,
      canonicalWindowsExecute, canonicalWindowsComplete, job.get(), &job->work) != napi_ok) return nullptr;
  if (napi_queue_async_work(env, job->work) != napi_ok) { napi_delete_async_work(env, job->work); return failure(env, "canonical queue", ERROR_NOT_ENOUGH_MEMORY); }
  job.release(); return promise;
}
