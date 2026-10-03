// SystemExtendedHandleInformation's ABI, decoded without retaining object pointers.
// The caller calibrates type against NtQueryObject(File), binds live Job members,
// and treats any missing/truncated snapshot as unavailable, never as zero files.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <unordered_set>
#include <vector>

namespace agnes_file_snapshot {
struct Entry {
  uintptr_t object, process, handle;
  uint32_t access;
  uint16_t creator, type;
  uint32_t attributes, reserved;
};
static_assert(sizeof(uintptr_t) == 8 && sizeof(Entry) == 40, "64-bit handle ABI required");
inline std::optional<std::vector<Entry>> decode(const void* data, size_t bytes) {
  if (bytes < 2 * sizeof(uintptr_t)) return {};
  uintptr_t count = 0;
  std::memcpy(&count, data, sizeof(count));
  if (count > (bytes - 2 * sizeof(uintptr_t)) / sizeof(Entry)) return {};
  std::vector<Entry> entries(count);
  if (count) std::memcpy(entries.data(), static_cast<const char*>(data) + 16, count * sizeof(Entry));
  return entries;
}
inline std::optional<uint16_t> calibrate(const std::vector<Entry>& entries, uintptr_t self,
                                        uintptr_t file, uintptr_t event) {
  uint16_t file_type = 0, event_type = 0;
  for (const auto& entry : entries) {
    if (entry.process != self) continue;
    if (entry.handle == file) file_type = entry.type;
    if (entry.handle == event) event_type = entry.type;
  }
  if (!file_type || !event_type || file_type == event_type) return {};
  return file_type;
}
inline uint64_t count(const std::vector<Entry>& entries, const std::unordered_set<uintptr_t>& members,
                      uint16_t type) {
  uint64_t files = 0;
  for (const auto& entry : entries)
    if (entry.type == type && members.count(entry.process)) ++files;
  return files;
}
}
