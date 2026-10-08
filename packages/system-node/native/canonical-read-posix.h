// Read-only descriptors opened one component at a time. No component may be a symlink.
#include <dirent.h>
#include <stdlib.h>

static int canonical_file(const char* path) {
  char parent[4096];
  size_t length = strlen(path);
  if (length >= sizeof(parent) || length < 2 || path[0] != '/') { errno = EINVAL; return -1; }
  memcpy(parent, path, length + 1);
  char* slash = strrchr(parent, '/');
  if (!slash || slash == parent || !slash[1] || strcmp(slash + 1, ".") == 0 || strcmp(slash + 1, "..") == 0) {
    errno = EINVAL; return -1;
  }
  *slash = '\0';
  int directory = open_absolute_directory(parent);
  if (directory < 0) return -1;
  int fd = openat(directory, slash + 1, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  int saved = errno;
  close(directory);
  errno = saved;
  return fd;
}
static napi_value open_canonical_file(napi_env env, napi_callback_info info) {
  napi_value args[1], result; size_t count = 1; char path[4096];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !string_arg(env, args[0], path, sizeof(path))) return NULL;
  int fd = canonical_file(path);
  if (fd < 0) return fail(env, "open canonical file", errno);
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) {
    close(fd); return fail(env, "regular file required", EACCES);
  }
  if (napi_create_int32(env, fd, &result) != napi_ok) { close(fd); return NULL; }
  return result;
}
static napi_value list_canonical_directory(napi_env env, napi_callback_info info) {
  napi_value args[1], result; size_t count = 1; char path[4096];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !string_arg(env, args[0], path, sizeof(path))) return NULL;
  int fd = open_absolute_directory(path);
  if (fd < 0) return fail(env, "open canonical directory", errno);
  DIR* directory = fdopendir(fd);
  if (!directory) { int saved = errno; close(fd); return fail(env, "list canonical directory", saved); }
  napi_create_array(env, &result);
  uint32_t index = 0; struct dirent* entry;
  errno = 0;
  while (index < 5001 && (entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    napi_value name; napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name);
    napi_set_element(env, result, index++, name);
  }
  int saved = errno; closedir(directory);
  if (saved) return fail(env, "read canonical directory", saved);
  return result;
}
