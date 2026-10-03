#include "../../native/windows-file-handles.h"
#include "../../../../examples/runtime-reference/native/job-file-snapshot.h"
#include <cassert>
#include <limits>
int main() {
  using agnes_file_snapshot::Entry;
  std::vector<Entry> system{
    {0, 10, 100, 0, 0, 7, 0, 0}, {0, 10, 101, 0, 0, 8, 0, 0},
    {0, 20, 200, 0, 0, 7, 0, 0}, {0, 20, 201, 0, 0, 7, 0, 0},
    {0, 20, 202, 0, 0, 8, 0, 0}, {0, 20, 203, 0, 0, 9, 0, 0},
    {0, 30, 300, 0, 0, 7, 0, 0},
  };
  auto type = agnes_file_snapshot::calibrate(system, 10, 100, 101);
  assert(type && *type == 7);
  assert(agnes_file_snapshot::count(system, {20}, *type) == 2);
  assert(!agnes_file_snapshot::calibrate(system, 10, 100, 999));
  system[1].type = 7;
  assert(!agnes_file_snapshot::calibrate(system, 10, 100, 101));
  std::vector<unsigned char> data(16 + system.size() * sizeof(Entry));
  uintptr_t count = system.size();
  memcpy(data.data(), &count, sizeof(count));
  memcpy(data.data() + 16, system.data(), system.size() * sizeof(Entry));
  assert(agnes_file_snapshot::decode(data.data(), data.size())->size() == count);
  assert(!agnes_file_snapshot::decode(data.data(), data.size() - 1));
  count = std::numeric_limits<uintptr_t>::max();
  memcpy(data.data(), &count, sizeof(count));
  assert(!agnes_file_snapshot::decode(data.data(), data.size()));
  assert(!agnes_file_snapshot::decode(nullptr, 0));

  using reference_file_table::Row;
  std::vector<Row> process{{100, 0, 0, 0, 7, 0, 0}, {101, 0, 0, 0, 8, 0, 0},
                          {102, 0, 0, 0, 7, 0, 0}, {103, 0, 0, 0, 9, 0, 0}};
  auto selected = reference_file_table::file_type(process, 100, 101);
  assert(selected && *selected == 7);
  assert(reference_file_table::files(process, *selected) == 2);
  assert(!reference_file_table::file_type(process, 100, 999));
  process[1].object_type = 7;
  assert(!reference_file_table::file_type(process, 100, 101));
  data.assign(16 + process.size() * sizeof(Row), 0);
  count = process.size();
  memcpy(data.data(), &count, 8); memcpy(data.data() + 16, process.data(), count * sizeof(Row));
  assert(reference_file_table::rows(data)->size() == count);
  data.pop_back();
  assert(!reference_file_table::rows(data));
  data.assign(16, 255);
  assert(!reference_file_table::rows(data));
  return 0;
}
