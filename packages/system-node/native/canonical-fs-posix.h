// Filesystem operations stay anchored to no-follow directory descriptors. Long operations run on
// Node's worker pool; neither recursion nor enumeration blocks the daemon's event loop.
#include <stdlib.h>

typedef struct { char* name; mode_t mode; } canonical_entry;
typedef struct {
  napi_async_work work; napi_deferred deferred;
  char operation[32], path[4096]; bool recursive; uint32_t mode; int error;
  struct stat meta; char* text; canonical_entry* entries; size_t count, capacity;
} canonical_job;

static napi_value open_canonical_writable_file(napi_env env, napi_callback_info info) {
  napi_value args[1], result; size_t count = 1; char path[4096];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !string_arg(env, args[0], path, sizeof(path))) return NULL;
  int fd = canonical_file_flags(path, O_WRONLY | O_CREAT);
  if (fd < 0) return fail(env, "open canonical writable file", errno);
  struct stat meta;
  if (fstat(fd, &meta) != 0) { int error = errno; close(fd); return fail(env, "stat canonical writable file", error); }
  if (!S_ISREG(meta.st_mode)) {
    int error = S_ISDIR(meta.st_mode) ? EISDIR : EACCES; close(fd);
    return fail(env, "regular writable file required", error);
  }
  if (napi_create_int32(env, fd, &result) != napi_ok) { close(fd); return NULL; }
  return result;
}

static int canonical_mkdir(const char* path, mode_t mode) {
  if (path[0] != '/' || !path[0]) { errno = EINVAL; return -1; }
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) return -1;
  const char* cursor = path + 1;
  while (*cursor) {
    const char* slash = strchr(cursor, '/');
    size_t length = slash ? (size_t)(slash - cursor) : strlen(cursor);
    if (!length || length > NAME_MAX || (length == 1 && cursor[0] == '.') ||
        (length == 2 && cursor[0] == '.' && cursor[1] == '.')) {
      close(current); errno = EINVAL; return -1;
    }
    char leaf[NAME_MAX + 1]; memcpy(leaf, cursor, length); leaf[length] = '\0';
    if (mkdirat(current, leaf, mode) != 0 && errno != EEXIST) {
      int error = errno; close(current); errno = error; return -1;
    }
    int next = openat(current, leaf, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0) {
      int error = errno;
      if (!slash && (error == ENOTDIR || error == ELOOP)) error = EEXIST;
      close(current); errno = error; return -1;
    }
    close(current); current = next;
    if (!slash) break;
    cursor = slash + 1;
  }
  close(current); return 0;
}

static int canonical_remove(int parent, const char* leaf, bool recursive, unsigned depth) {
  if (depth >= 256) { errno = ELOOP; return -1; }
  struct stat observed;
  if (fstatat(parent, leaf, &observed, AT_SYMLINK_NOFOLLOW) != 0) return -1;
  if (!S_ISDIR(observed.st_mode)) return unlinkat(parent, leaf, 0);
  if (!recursive) { errno = EISDIR; return -1; }
  int fd = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  struct stat opened;
  if (fstat(fd, &opened) != 0 || opened.st_dev != observed.st_dev || opened.st_ino != observed.st_ino) {
    close(fd); errno = EACCES; return -1;
  }
  DIR* directory = fdopendir(fd);
  if (!directory) { int error = errno; close(fd); errno = error; return -1; }
  int error = 0;
  for (;;) {
    errno = 0; struct dirent* entry = readdir(directory);
    if (!entry) { error = errno; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (canonical_remove(dirfd(directory), entry->d_name, true, depth + 1) != 0 && errno != ENOENT) { error = errno; break; }
  }
  closedir(directory);
  if (error) { errno = error; return -1; }
  struct stat now;
  if (fstatat(parent, leaf, &now, AT_SYMLINK_NOFOLLOW) != 0) return -1;
  if (!S_ISDIR(now.st_mode) || now.st_dev != opened.st_dev || now.st_ino != opened.st_ino) {
    errno = EACCES; return -1;
  }
  return unlinkat(parent, leaf, AT_REMOVEDIR);
}

static int canonical_list(canonical_job* job) {
  int fd = open_absolute_directory(job->path);
  if (fd < 0) return -1;
  DIR* directory = fdopendir(fd);
  if (!directory) { int error = errno; close(fd); errno = error; return -1; }
  int error = 0;
  for (;;) {
    errno = 0; struct dirent* entry = readdir(directory);
    if (!entry) { error = errno; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    struct stat meta;
    if (fstatat(dirfd(directory), entry->d_name, &meta, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      error = errno; break;
    }
    if (job->count == job->capacity) {
      size_t capacity = job->capacity ? job->capacity * 2 : 32;
      if (capacity < job->capacity || capacity > UINT32_MAX || capacity > SIZE_MAX / sizeof(canonical_entry)) { error = ENOMEM; break; }
      canonical_entry* entries = realloc(job->entries, capacity * sizeof(canonical_entry));
      if (!entries) { error = ENOMEM; break; }
      job->entries = entries; job->capacity = capacity;
    }
    char* name = strdup(entry->d_name);
    if (!name) { error = ENOMEM; break; }
    job->entries[job->count++] = (canonical_entry){name, meta.st_mode};
  }
  closedir(directory);
  if (error) { errno = error; return -1; }
  return 0;
}

static void canonical_execute(napi_env env, void* value) {
  (void)env; canonical_job* job = value;
  if (!strcmp(job->operation, "mkdir")) {
    if (canonical_mkdir(job->path, (mode_t)job->mode) != 0) job->error = errno;
    return;
  }
  if (!strcmp(job->operation, "list")) {
    if (canonical_list(job) != 0) job->error = errno;
    return;
  }
  char leaf[NAME_MAX + 1];
  int parent;
  if (!strcmp(job->path, "/") && !strcmp(job->operation, "stat")) {
    parent = open_absolute_directory("/");
    if (parent < 0) { job->error = errno; return; }
    if (fstat(parent, &job->meta) != 0) job->error = errno;
    close(parent); return;
  }
  parent = canonical_parent(job->path, leaf, sizeof(leaf));
  if (parent < 0) { job->error = errno; return; }
  if (!strcmp(job->operation, "rm")) {
    if (canonical_remove(parent, leaf, job->recursive, 0) != 0) job->error = errno;
  } else {
    if (fstatat(parent, leaf, &job->meta, AT_SYMLINK_NOFOLLOW) != 0) job->error = errno;
    else if (S_ISLNK(job->meta.st_mode) || !strcmp(job->operation, "readlink")) {
      char text[4096]; ssize_t length = readlinkat(parent, leaf, text, sizeof(text) - 1);
      if (length < 0) job->error = errno;
      else if ((size_t)length == sizeof(text) - 1) job->error = ENAMETOOLONG;
      else { text[length] = '\0'; job->text = strdup(text); if (!job->text) job->error = ENOMEM; }
    }
  }
  close(parent);
}
static const char* canonical_kind(mode_t mode) {
  return S_ISLNK(mode) ? "symlink" : S_ISDIR(mode) ? "dir" : S_ISREG(mode) ? "file" : "other";
}
static void canonical_property(napi_env env, napi_value object, const char* key, const char* text) {
  napi_value value; napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, key, value);
}
static void canonical_complete(napi_env env, napi_status status, void* value) {
  canonical_job* job = value; napi_value result;
  if (status != napi_ok && !job->error) job->error = EIO;
  if (job->error) {
    fail(env, "canonical filesystem operation", job->error);
    napi_get_and_clear_last_exception(env, &result);
    if (!strcmp(job->operation, "rm") && !job->recursive && job->error == EISDIR)
      canonical_property(env, result, "code", "ERR_FS_EISDIR");
    napi_reject_deferred(env, job->deferred, result);
  } else {
    if (!strcmp(job->operation, "stat")) {
      napi_create_object(env, &result); canonical_property(env, result, "kind", canonical_kind(job->meta.st_mode));
      napi_value number; napi_create_double(env, (double)job->meta.st_size, &number);
      napi_set_named_property(env, result, "size", number);
#ifdef __APPLE__
      double mtime = job->meta.st_mtimespec.tv_sec * 1000.0 + job->meta.st_mtimespec.tv_nsec / 1000000.0;
#else
      double mtime = job->meta.st_mtim.tv_sec * 1000.0 + job->meta.st_mtim.tv_nsec / 1000000.0;
#endif
      napi_create_double(env, mtime, &number); napi_set_named_property(env, result, "mtimeMs", number);
      if (job->text) canonical_property(env, result, "linkTarget", job->text);
    } else if (!strcmp(job->operation, "list")) {
      napi_create_array_with_length(env, job->count, &result);
      for (size_t i = 0; i < job->count; i++) {
        napi_value entry; napi_create_object(env, &entry);
        canonical_property(env, entry, "name", job->entries[i].name);
        canonical_property(env, entry, "kind", canonical_kind(job->entries[i].mode));
        napi_set_element(env, result, (uint32_t)i, entry);
      }
    } else if (!strcmp(job->operation, "readlink")) napi_create_string_utf8(env, job->text, NAPI_AUTO_LENGTH, &result);
    else napi_get_undefined(env, &result);
    napi_resolve_deferred(env, job->deferred, result);
  }
  for (size_t i = 0; i < job->count; i++) free(job->entries[i].name);
  free(job->entries); free(job->text); napi_delete_async_work(env, job->work); free(job);
}
static napi_value canonical_fs(napi_env env, napi_callback_info info) {
  napi_value args[4], result, resource; size_t count = 4;
  canonical_job* job = calloc(1, sizeof(canonical_job));
  if (!job) return fail(env, "canonical operation allocation", ENOMEM);
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 4 ||
      !string_arg(env, args[0], job->operation, sizeof(job->operation)) ||
      !string_arg(env, args[1], job->path, sizeof(job->path)) ||
      napi_get_value_bool(env, args[2], &job->recursive) != napi_ok ||
      napi_get_value_uint32(env, args[3], &job->mode) != napi_ok || job->mode > 0777) { free(job); bool pending = false; napi_is_exception_pending(env, &pending); return pending ? NULL : fail(env, "canonical arguments", EINVAL); }
  if (strcmp(job->operation, "stat") && strcmp(job->operation, "readlink") && strcmp(job->operation, "list") &&
      strcmp(job->operation, "mkdir") && strcmp(job->operation, "rm")) {
    free(job); return fail(env, "canonical operation", EINVAL);
  }
  napi_create_string_utf8(env, "canonical filesystem", NAPI_AUTO_LENGTH, &resource);
  if (napi_create_promise(env, &job->deferred, &result) != napi_ok ||
      napi_create_async_work(env, NULL, resource, canonical_execute, canonical_complete, job, &job->work) != napi_ok) {
    free(job); return fail(env, "canonical operation creation", EIO);
  }
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    napi_delete_async_work(env, job->work); free(job); return fail(env, "canonical operation queue", EIO);
  }
  return result;
}
