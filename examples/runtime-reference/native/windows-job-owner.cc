// Independent reference: atomic Job-list process creation, per-process File
// tables, and pipe polling. Never imports or links the Host supervisor.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <psapi.h>
#include <sddl.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <string>
#include <thread>
#include "job-file-snapshot.h"

struct Resource {
  HANDLE h = nullptr;
  ~Resource() { reset(); }
  void reset() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); h = nullptr; }
};
using QueryProcess = LONG(NTAPI*)(HANDLE, ULONG, void*, ULONG, ULONG*);
using QueryType = LONG(NTAPI*)(HANDLE, ULONG, void*, ULONG, ULONG*);
template<typename Signature> Signature lookup(const char* symbol) {
  auto exported = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), symbol);
  Signature result{};
  static_assert(sizeof(result) == sizeof(exported));
  memcpy(&result, &exported, sizeof(result));
  return result;
}
static bool emit(const std::string& record) {
  const char* p = record.data(); size_t left = record.size();
  while (left) {
    DWORD sent{};
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), p, static_cast<DWORD>(left), &sent, nullptr) || sent == 0) return false;
    p += sent; left -= sent;
  }
  return true;
}
static int denied(const char* detail) {
  emit("{\"kind\":\"refusal\",\"detailCode\":\"" + std::string(detail) + "\"}\n");
  return 125;
}
static bool low_token() {
  Resource original, reduced;
  PSID low = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT, &original.h)) return false;
  if (!CreateRestrictedToken(original.h, DISABLE_MAX_PRIVILEGE, 0, nullptr, 0, nullptr, 0, nullptr, &reduced.h)) return false;
  if (!ConvertStringSidToSidW(L"S-1-16-4096", &low)) return false;
  TOKEN_MANDATORY_LABEL level{{low, SE_GROUP_INTEGRITY}};
  const bool changed = SetTokenInformation(reduced.h, TokenIntegrityLevel, &level,
    static_cast<DWORD>(sizeof(level) + GetLengthSid(low))) != FALSE;
  LocalFree(low);
  return changed && ImpersonateLoggedOnUser(reduced.h);
}
class ProcessTables {
  QueryProcess inspect = lookup<QueryProcess>("NtQueryInformationProcess");
  uint32_t file_index{};
  bool table(HANDLE process, std::vector<reference_file_table::Row>& entries) {
    if (inspect == nullptr) return false;
    std::vector<unsigned char> bytes(4096);
    for (unsigned attempt = 0; attempt != 16; ++attempt) {
      ULONG used{};
      LONG outcome = inspect(process, 51, bytes.data(), static_cast<ULONG>(bytes.size()), &used);
      if (outcome >= 0) {
        if (used < 16 || used > bytes.size()) return false;
        bytes.resize(used);
        auto parsed = reference_file_table::rows(bytes);
        if (!parsed) return false;
        entries.swap(*parsed); return true;
      }
      if (static_cast<ULONG>(outcome) != 0xc0000004UL || bytes.size() >= 64 * 1024 * 1024) return false;
      const auto next_size = (std::max)(bytes.size() * 2, static_cast<size_t>(used));
      if (next_size > 64 * 1024 * 1024) return false;
      bytes.resize(next_size);
    }
    return false;
  }
 public:
  bool ready() {
    Resource file, signal;
    file.h = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    signal.h = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    auto identify = lookup<QueryType>("NtQueryObject");
    if (file.h == INVALID_HANDLE_VALUE || !signal.h || !identify) return false;
    std::array<uintptr_t, 512> storage{}; ULONG used{};
    if (identify(file.h, 2, storage.data(), static_cast<ULONG>(sizeof(storage)), &used) < 0) return false;
    const auto& type_name = *reinterpret_cast<UNICODE_STRING*>(storage.data());
    const auto base = reinterpret_cast<uintptr_t>(storage.data());
    const auto pointer = reinterpret_cast<uintptr_t>(type_name.Buffer);
    if (type_name.Length != sizeof(wchar_t) * 4 || pointer < base || pointer > base + sizeof(storage) - 8 ||
        std::wstring(type_name.Buffer, 4) != L"File") return false;
    std::vector<reference_file_table::Row> own;
    if (!table(GetCurrentProcess(), own)) return false;
    auto index = reference_file_table::file_type(own, reinterpret_cast<uintptr_t>(file.h), reinterpret_cast<uintptr_t>(signal.h));
    if (!index) return false;
    file_index = *index; return true;
  }
  bool measure(HANDLE group, uint64_t& handles, uint64_t& working_set) {
    std::vector<uintptr_t> ids(256);
    auto list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(ids.data());
    while (!QueryInformationJobObject(group, JobObjectBasicProcessIdList, list, static_cast<DWORD>(ids.size() * sizeof(uintptr_t)), nullptr)) {
      if (GetLastError() != ERROR_MORE_DATA || ids.size() >= 131072) return false;
      ids.resize(ids.size() * 2); list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(ids.data());
    }
    if (list->NumberOfProcessIdsInList > ids.size() - 1) return false;
    handles = working_set = 0;
    for (DWORD pos = 0; pos != list->NumberOfProcessIdsInList; ++pos) {
      Resource member;
      member.h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, static_cast<DWORD>(list->ProcessIdList[pos]));
      if (!member.h) { if (GetLastError() == ERROR_INVALID_PARAMETER) continue; return false; }
      if (WaitForSingleObject(member.h, 0) == WAIT_OBJECT_0) continue;
      BOOL belongs{}; PROCESS_MEMORY_COUNTERS counters{};
      if (!IsProcessInJob(member.h, group, &belongs) || !belongs || !GetProcessMemoryInfo(member.h, &counters, sizeof(counters))) {
        if (WaitForSingleObject(member.h, 0) == WAIT_OBJECT_0) continue;
        return false;
      }
      working_set += counters.WorkingSetSize;
      if (file_index) {
        std::vector<reference_file_table::Row> entries;
        if (!table(member.h, entries)) { if (WaitForSingleObject(member.h, 0) == WAIT_OBJECT_0) continue; return false; }
        handles += reference_file_table::files(entries, file_index);
      }
    }
    return true;
  }
};
static std::wstring argument(const wchar_t* text) {
  std::wstring value(text), encoded(1, L'"');
  for (size_t position = 0; position < value.length();) {
    size_t end = position;
    while (end < value.length() && value[end] == L'\\') ++end;
    const size_t run = end - position;
    if (end == value.length()) { encoded.append(run * 2, L'\\'); break; }
    if (value[end] == L'"') { encoded.append(run * 2 + 1, L'\\'); encoded.push_back(L'"'); }
    else { encoded.append(run, L'\\'); encoded.push_back(value[end]); }
    position = end + 1;
  }
  encoded.push_back(L'"'); return encoded;
}
int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && (wcscmp(argv[1], L"--probe-files") == 0 || wcscmp(argv[1], L"--probe-files-low") == 0)) {
    const bool token = wcscmp(argv[1], L"--probe-files-low") != 0 || low_token();
    ProcessTables tables; bool available = token && tables.ready(); RevertToSelf();
    emit(std::string("{\"fileHandles\":") + (available ? "true" : "false") + ",\"restrictedTokenApplied\":" + (token ? "true" : "false") + "}\n");
    return token ? 0 : 125;
  }
  if (argc <= 7) return denied("exec_runner_unavailable");
  std::array<uint64_t, 5> budget{};
  for (size_t slot = 0; slot < budget.size(); ++slot) {
    wchar_t* tail{}; budget[slot] = _wcstoui64(argv[slot + 1], &tail, 10);
    if (argv[slot + 1][0] == L'-' || *tail || budget[slot] == 0 || budget[slot] > 9007199254740991ULL) return denied("exec_resource_bounds");
  }
  if (wcscmp(argv[6], L"five-limits")) return denied("exec_limit_openFiles_unsupported");
  if (budget[0] > 922337203685477ULL || budget[1] >= INFINITE || budget[3] > 67108864 || budget[4] > 65535) return denied("exec_resource_bounds");
  ProcessTables tables;
  auto receive_exact = [](void* destination, size_t size) {
    auto next = static_cast<char*>(destination);
    while (size) { DWORD read{}; if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), next, static_cast<DWORD>(size), &read, nullptr) || !read) return false; next += read; size -= read; }
    return true;
  };
  uint32_t input_size{};
  if (!receive_exact(&input_size, sizeof(input_size)) || input_size > 1048576) return denied("exec_runner_unavailable");
  std::vector<char> input(input_size);
  if (!receive_exact(input.data(), input.size())) return denied("exec_runner_unavailable");
  Resource group, notifications, finished;
  group.h = CreateJobObjectW(nullptr, nullptr); notifications.h = CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 0); finished.h = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!group.h || !notifications.h || !finished.h) return denied("exec_runner_unavailable");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION hard{};
  auto& basic = hard.BasicLimitInformation;
  basic.LimitFlags = JOB_OBJECT_LIMIT_JOB_TIME | JOB_OBJECT_LIMIT_PROCESS_TIME | JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  basic.PerJobUserTimeLimit.QuadPart = static_cast<LONGLONG>(budget[0] * 10000);
  basic.PerProcessUserTimeLimit.QuadPart = basic.PerJobUserTimeLimit.QuadPart;
  basic.ActiveProcessLimit = static_cast<DWORD>(budget[4]); hard.ProcessMemoryLimit = static_cast<SIZE_T>(budget[2]); hard.JobMemoryLimit = hard.ProcessMemoryLimit;
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT destination{group.h, notifications.h};
  if (!SetInformationJobObject(group.h, JobObjectExtendedLimitInformation, &hard, sizeof(hard)) || !SetInformationJobObject(group.h, JobObjectAssociateCompletionPortInformation, &destination, sizeof(destination))) return denied("exec_runner_unavailable");
  Resource sink, feeder, stdout_read, stdout_write, stderr_read, stderr_write;
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE};
  if (!CreatePipe(&sink.h, &feeder.h, &attributes, 0) || !CreatePipe(&stdout_read.h, &stdout_write.h, &attributes, 0) || !CreatePipe(&stderr_read.h, &stderr_write.h, &attributes, 0)) return denied("exec_runner_unavailable");
  for (HANDLE private_handle : {feeder.h, stdout_read.h, stderr_read.h})
    if (!SetHandleInformation(private_handle, HANDLE_FLAG_INHERIT, 0)) return denied("exec_runner_unavailable");
  SIZE_T bytes{}; InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
  std::vector<unsigned char> launch_attributes(bytes);
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = sink.h; startup.StartupInfo.hStdOutput = stdout_write.h; startup.StartupInfo.hStdError = stderr_write.h;
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(launch_attributes.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &bytes)) return denied("exec_runner_unavailable");
  HANDLE streams[] = {sink.h, stdout_write.h, stderr_write.h};
  const bool setup = UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, streams, sizeof(streams), nullptr, nullptr) &&
    UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &group.h, sizeof(group.h), nullptr, nullptr);
  std::wstring command_line;
  for (int part = 7; part != argc; ++part) { command_line += argument(argv[part]); command_line += L' '; }
  PROCESS_INFORMATION launched{};
  const bool created = setup && CreateProcessW(argv[7], command_line.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup.StartupInfo, &launched);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (!created) return denied("exec_runner_unavailable");
  Resource target, main_thread; target.h = launched.hProcess; main_thread.h = launched.hThread;
  sink.reset(); stdout_write.reset(); stderr_write.reset();
  uint64_t file_peak{}, rss_peak{};
  if (!tables.measure(group.h, file_peak, rss_peak)) {
    TerminateJobObject(group.h, 125);
    const auto began = GetTickCount64();
    for (;;) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION summary{};
      if (QueryInformationJobObject(group.h, JobObjectBasicAccountingInformation, &summary, sizeof(summary), nullptr) &&
          summary.ActiveProcesses == 0) return denied("exec_runner_unavailable");
      if (GetTickCount64() - began >= 3000) return denied("exec_cleanup_unknown");
      Sleep(5);
    }
  }
  std::atomic<int> termination{-1};
  const char* labels[] = {"cpuMs", "wallMs", "memoryBytes", "outputBytes", "processes", "unavailable", "cancel", "owner", "residual", "unavailable", "cleanup"};
  auto stop = [&](int reason) { int running = -1; termination.compare_exchange_strong(running, reason); TerminateJobObject(group.h, 1); };
  std::thread deadline([&] { if (WaitForSingleObject(finished.h, static_cast<DWORD>(budget[1])) == WAIT_TIMEOUT) stop(1); });
  std::atomic<DWORD> writer_id{0}; std::atomic<bool> writer_finished{false};
  std::thread write_input([&] {
    writer_id.store(GetCurrentThreadId());
    size_t sent{};
    while (sent < input.size() && WaitForSingleObject(finished.h, 0) == WAIT_TIMEOUT) {
      DWORD n{};
      if (!WriteFile(feeder.h, input.data() + sent, static_cast<DWORD>(input.size() - sent), &n, nullptr) || !n) break;
      sent += n;
    }
    feeder.reset(); writer_finished.store(true);
  });
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION starting_allocation{};
  uint64_t starting_commit{};
  if (!QueryInformationJobObject(group.h, JobObjectExtendedLimitInformation, &starting_allocation, sizeof(starting_allocation), nullptr)) stop(9);
  else {
    starting_commit = starting_allocation.PeakJobMemoryUsed;
    if (starting_commit > budget[2] || rss_peak > budget[2]) stop(2);
  }
  if (termination.load() == -1 && ResumeThread(main_thread.h) == MAXDWORD) stop(9);
  std::array<std::vector<unsigned char>, 2> output;
  uint64_t captured{}, observed{}, cpu_total{}, commitment{starting_commit}, process_peak{1}, max_gap{}, previous = GetTickCount64(), stopping{};
  bool empty = false; int left = -1;
  auto drain = [&](HANDLE pipe, size_t stream) {
    for (unsigned turn = 0; turn != 16; ++turn) {
      DWORD waiting{}; if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &waiting, nullptr) || !waiting) break;
      unsigned char block[4096]; DWORD n{};
      if (!ReadFile(pipe, block, (std::min)(waiting, static_cast<DWORD>(sizeof(block))), &n, nullptr)) break;
      observed += n; size_t keep = static_cast<size_t>((std::min)(static_cast<uint64_t>(n), budget[3] - captured));
      output[stream].insert(output[stream].end(), block, block + keep); captured += keep;
      if (observed > budget[3]) stop(3);
    }
  };
  do {
    DWORD message{}; ULONG_PTR key{}; OVERLAPPED* datum{};
    while (GetQueuedCompletionStatus(notifications.h, &message, &key, &datum, 0)) {
      if (key != reinterpret_cast<ULONG_PTR>(group.h)) stop(9);
      switch (message) {
        case JOB_OBJECT_MSG_END_OF_JOB_TIME: case JOB_OBJECT_MSG_END_OF_PROCESS_TIME: stop(0); break;
        case JOB_OBJECT_MSG_JOB_MEMORY_LIMIT: case JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT: stop(2); break;
        case JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT: stop(4); break;
      }
    }
    DWORD control{};
    if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &control, nullptr)) stop(7);
    else if (control) stop(6);
    drain(stdout_read.h, 0); drain(stderr_read.h, 1);
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION usage{}; JOBOBJECT_EXTENDED_LIMIT_INFORMATION allocation{};
    if (!QueryInformationJobObject(group.h, JobObjectBasicAccountingInformation, &usage, sizeof(usage), nullptr) || !QueryInformationJobObject(group.h, JobObjectExtendedLimitInformation, &allocation, sizeof(allocation), nullptr)) stop(9);
    else {
      left = static_cast<int>(usage.ActiveProcesses); process_peak = (std::max)(process_peak, static_cast<uint64_t>(usage.ActiveProcesses));
      cpu_total = static_cast<uint64_t>(usage.TotalKernelTime.QuadPart + usage.TotalUserTime.QuadPart) / 10000;
      commitment = (std::max)(commitment, static_cast<uint64_t>(allocation.PeakJobMemoryUsed));
      if (cpu_total >= budget[0]) stop(0);
      if (left == 0) empty = true;
      else {
        if (WaitForSingleObject(target.h, 0) == WAIT_OBJECT_0) stop(8);
        uint64_t count{}, resident{};
        if (!tables.measure(group.h, count, resident)) stop(9);
        else { file_peak = (std::max)(file_peak, count); rss_peak = (std::max)(rss_peak, resident); if (resident > budget[2]) stop(2); }
      }
    }
    const auto tick = GetTickCount64(); max_gap = (std::max)(max_gap, tick - previous); previous = tick;
    if (termination.load() != -1) { TerminateJobObject(group.h, 1); if (!stopping) stopping = tick; if (tick - stopping > 3000) { termination.store(10); left = -1; break; } }
    if (!empty) Sleep(10);
  } while (!empty);
  SetEvent(finished.h); deadline.join();
  const auto drain_start = GetTickCount64();
  while (!writer_finished.load()) {
    Resource writer; writer.h = OpenThread(THREAD_TERMINATE, FALSE, writer_id.load());
    if (writer.h) CancelSynchronousIo(writer.h);
    if (GetTickCount64() - drain_start > 3000) ExitProcess(125);
    Sleep(5);
  }
  write_input.join(); drain(stdout_read.h, 0); drain(stderr_read.h, 1);
  for (size_t stream = 0; stream != output.size(); ++stream) {
    for (size_t index = 0; index < output[stream].size(); index += 1024) {
      std::string hex; constexpr char alphabet[] = "0123456789abcdef";
      for (size_t offset = index; offset < (std::min)(index + 1024, output[stream].size()); ++offset) { auto byte = output[stream][offset]; hex.push_back(alphabet[byte / 16]); hex.push_back(alphabet[byte % 16]); }
      emit("{\"kind\":\"output\",\"stream\":" + std::to_string(stream) + ",\"hex\":\"" + hex + "\"}\n");
    }
  }
  DWORD status{}; GetExitCodeProcess(target.h, &status);
  emit("{\"kind\":\"metrics\",\"pid\":" + std::to_string(launched.dwProcessId) + ",\"final\":true,\"reason\":\"" + (termination.load() == -1 ? "completed" : labels[termination.load()]) +
    "\",\"code\":" + std::to_string(static_cast<int32_t>(status)) + ",\"signal\":0,\"cpuMs\":" + std::to_string(cpu_total) + ",\"rss\":" + std::to_string(rss_peak) +
    ",\"committedBytes\":" + std::to_string(commitment) + ",\"processes\":" + std::to_string(process_peak) + ",\"files\":" + std::to_string(file_peak) + ",\"filesEnforced\":false" +
    ",\"outputBytes\":" + std::to_string(observed) + ",\"intervalMs\":10,\"maxGapMs\":" + std::to_string(max_gap) + ",\"remaining\":" + std::to_string(left) + ",\"ownershipVerified\":" + (empty ? "true" : "false") + ",\"residualObserved\":0,\"ownership\":\"strong\"}\n");
  return empty ? 0 : 125;
}
