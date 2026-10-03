// ProcessHandleInformation ABI. Only object type is used; object names and
// total handle counts are deliberately not substitutes for the File ceiling.
#pragma once
#include <cstdint>
#include <cstring>
#include <optional>
#include <vector>

namespace reference_file_table {
struct Row {
  uintptr_t value, handle_refs, pointer_refs;
  uint32_t granted, object_type, flags, unused;
};
static_assert(sizeof(Row) == 40 && sizeof(uintptr_t) == 8, "Requires a 64-bit process snapshot");
inline std::optional<std::vector<Row>> rows(const std::vector<unsigned char>& buffer) {
  if (buffer.size() < 16) return std::nullopt;
  uintptr_t amount;
  std::memcpy(&amount, buffer.data(), 8);
  if (amount > (buffer.size() - 16) / 40) return std::nullopt;
  std::vector<Row> result;
  for (uintptr_t offset = 0; offset != amount; ++offset) {
    Row row{};
    std::memcpy(&row, buffer.data() + 16 + offset * 40, 40);
    result.push_back(row);
  }
  return result;
}
inline std::optional<uint32_t> file_type(const std::vector<Row>& table, uintptr_t marker,
                                        uintptr_t non_file) {
  std::optional<uint32_t> selected, excluded;
  for (auto it = table.rbegin(); it != table.rend(); ++it) {
    if (it->value == marker) selected = it->object_type;
    if (it->value == non_file) excluded = it->object_type;
  }
  if (!selected || !excluded || !*selected || !*excluded || selected == excluded) return std::nullopt;
  return selected;
}
inline uint64_t files(const std::vector<Row>& table, uint32_t expected) {
  uint64_t total = 0;
  for (auto it = table.cbegin(); it != table.cend(); ++it) total += it->object_type == expected ? 1 : 0;
  return total;
}
}
