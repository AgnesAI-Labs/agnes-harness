#include <math.h>

// Anchor deletion to a parent opened component-by-component without following links.
static napi_value delete_skill_entry(napi_env env, napi_callback_info info) {
  napi_value args[6]; size_t count = 6;
  char path[PATH_MAX]; double expected[4] = {0}; uint64_t identities[2]; bool directory;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 6)
    return fail(env, "Skill arguments", EINVAL);
  if (!string_arg(env, args[0], path, sizeof(path))) return NULL;
  for (size_t i = 0; i < 2; ++i) {
    bool lossless;
    if (napi_get_value_bigint_uint64(env, args[i + 1], &identities[i], &lossless) != napi_ok || !lossless)
      return fail(env, "Skill identity", EINVAL);
  }
  for (size_t i = 2; i < 4; ++i)
    if (napi_get_value_double(env, args[i + 1], &expected[i]) != napi_ok ||
        !isfinite(expected[i]) || expected[i] < 0 || expected[i] > 9007199254740991.0)
      return fail(env, "Skill identity", EINVAL);
  if (napi_get_value_bool(env, args[5], &directory) != napi_ok) return fail(env, "Skill type", EINVAL);
  char* name = strrchr(path, '/');
  if (!name || name == path || !name[1] || !strcmp(name + 1, ".") || !strcmp(name + 1, ".."))
    return fail(env, "Skill path", EINVAL);
  *name++ = '\0';
  const char* parent_path = path;
#ifdef __APPLE__
  char normalized[PATH_MAX];
  if (!normalize_system_root_alias(path, normalized, sizeof(normalized), &parent_path))
    return fail(env, "Skill parent", errno);
#endif
  int parent = open_absolute_directory(parent_path);
  if (parent < 0) return fail(env, "Skill parent", errno);
  struct stat meta;
  if (fstatat(parent, name, &meta, AT_SYMLINK_NOFOLLOW) != 0) {
    int error = errno; close(parent); return fail(env, "Skill identity", error);
  }
#ifdef __APPLE__
  double mtime = meta.st_mtimespec.tv_sec * 1000.0 + meta.st_mtimespec.tv_nsec / 1000000.0;
#else
  double mtime = meta.st_mtim.tv_sec * 1000.0 + meta.st_mtim.tv_nsec / 1000000.0;
#endif
  if ((uint64_t)meta.st_dev != identities[0] || (uint64_t)meta.st_ino != identities[1] ||
      (directory ? !S_ISDIR(meta.st_mode) : (!S_ISREG(meta.st_mode) || meta.st_nlink != 1 ||
       (double)meta.st_size != expected[2] || fabs(mtime - expected[3]) > 0.001))) {
    close(parent); return fail(env, "Skill identity", EACCES);
  }
  if (unlinkat(parent, name, directory ? AT_REMOVEDIR : 0) != 0) {
    int error = errno; close(parent); return fail(env, "Skill delete", error);
  }
  int result = fsync(parent), error = errno; close(parent);
  if (result != 0) return fail(env, "Skill durability", error);
  napi_value value; napi_get_undefined(env, &value); return value;
}
