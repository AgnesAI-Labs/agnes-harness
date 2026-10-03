// Standalone Job supervisor. stdin: LE length + command bytes, then owner
// liveness/cancel. stdout: bounded ASCII frames, never command/environment text.
// Job membership is strong for directly inherited processes; this helper is not
// a filesystem sandbox or a protected supervisor against same-user attackers.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <psapi.h>
#include <sddl.h>
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cwchar>
#include <limits>
#include <mutex>
#include <string>
#include <thread>
#include "windows-file-handles.h"

class Handle {
 public:
  HANDLE value;
  explicit Handle(HANDLE h = nullptr) : value(h) {}
  ~Handle() { close(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  void close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = nullptr; }
};
template<class T> T procedure(const char* name) {
  FARPROC address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), name);
  T function = nullptr;
  static_assert(sizeof(function) == sizeof(address));
  std::memcpy(&function, &address, sizeof(function));
  return function;
}
using SystemQuery = LONG(NTAPI*)(ULONG, void*, ULONG, ULONG*);
using ObjectQuery = LONG(NTAPI*)(HANDLE, ULONG, void*, ULONG, ULONG*);
static bool write_frame(const std::string& text) {
  size_t offset = 0;
  while (offset < text.size()) {
    DWORD n = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text.data() + offset,
                   static_cast<DWORD>(text.size() - offset), &n, nullptr) || !n) return false;
    offset += n;
  }
  return true;
}
static int refuse(const char* code) {
  write_frame(std::string("{\"kind\":\"refusal\",\"detailCode\":\"") + code + "\"}\n");
  return 125;
}
static bool read_exact(void* data, DWORD length) {
  auto bytes = static_cast<char*>(data);
  DWORD offset = 0;
  while (offset < length) {
    DWORD got = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes + offset, length - offset, &got, nullptr) || !got)
      return false;
    offset += got;
  }
  return true;
}
static std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t ch : value) {
    if (ch == L'\\') { ++slashes; continue; }
    result.append(slashes * (ch == L'\"' ? 2 : 1), L'\\');
    slashes = 0;
    if (ch == L'\"') result += L'\\';
    result += ch;
  }
  result.append(slashes * 2, L'\\');
  return result + L'\"';
}
static bool lower_integrity() {
  Handle token, restricted;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
                        &token.value) ||
      !CreateRestrictedToken(token.value, DISABLE_MAX_PRIVILEGE, 0, nullptr, 0, nullptr, 0, nullptr,
                             &restricted.value)) return false;
  PSID sid = nullptr;
  if (!ConvertStringSidToSidW(L"S-1-16-4096", &sid)) return false;
  TOKEN_MANDATORY_LABEL label{};
  label.Label.Attributes = SE_GROUP_INTEGRITY;
  label.Label.Sid = sid;
  bool ok = SetTokenInformation(restricted.value, TokenIntegrityLevel, &label,
                                static_cast<DWORD>(sizeof(label) + GetLengthSid(sid))) &&
            ImpersonateLoggedOnUser(restricted.value);
  LocalFree(sid);
  return ok;
}
class Files {
  SystemQuery query = procedure<SystemQuery>("NtQuerySystemInformation");
  ObjectQuery object = procedure<ObjectQuery>("NtQueryObject");
  Handle marker{CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                            OPEN_EXISTING, 0, nullptr)};
  Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  std::vector<unsigned char> buffer;
  uint16_t type = 0;
 public:
  bool snapshot(std::vector<agnes_file_snapshot::Entry>& rows) {
    if (!query) return false;
    for (unsigned retry = 0; retry < 8; ++retry) {
      if (buffer.empty()) buffer.resize(1024 * 1024);
      ULONG returned = 0;
      const LONG status = query(64, buffer.data(), static_cast<ULONG>(buffer.size()), &returned);
      if (status >= 0) {
        if (returned > buffer.size()) return false;
        auto decoded = agnes_file_snapshot::decode(buffer.data(), returned);
        if (!decoded) return false;
        rows = std::move(*decoded);
        return true;
      }
      if (static_cast<ULONG>(status) != 0xc0000004UL) return false;
      size_t next = std::max(buffer.size() * 2, static_cast<size_t>(returned));
      if (next > 256 * 1024 * 1024) return false;
      buffer.resize(next);
    }
    return false;
  }
  bool initialize() {
    if (!object || marker.value == INVALID_HANDLE_VALUE || !event.value) return false;
    std::vector<uintptr_t> information(256);
    ULONG length = 0;
    if (object(marker.value, 2, information.data(), static_cast<ULONG>(information.size() * 8), &length) < 0)
      return false;
    auto name = reinterpret_cast<const UNICODE_STRING*>(information.data());
    auto begin = reinterpret_cast<uintptr_t>(information.data()), address = reinterpret_cast<uintptr_t>(name->Buffer);
    if (name->Length != 8 || address < begin || address > begin + information.size() * 8 - 8 ||
        std::wstring(name->Buffer, 4) != L"File") return false;
    std::vector<agnes_file_snapshot::Entry> rows;
    if (!snapshot(rows)) return false;
    auto selected = agnes_file_snapshot::calibrate(rows, GetCurrentProcessId(),
      reinterpret_cast<uintptr_t>(marker.value), reinterpret_cast<uintptr_t>(event.value));
    if (!selected) return false;
    type = *selected;
    return true;
  }
  bool sample(HANDLE job, uint64_t& files, uint64_t& rss) {
    std::vector<unsigned char> list(1024);
    JOBOBJECT_BASIC_PROCESS_ID_LIST* members = nullptr;
    for (;;) {
      members = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(list.data());
      if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, members,
                                   static_cast<DWORD>(list.size()), nullptr)) break;
      if (GetLastError() != ERROR_MORE_DATA || list.size() >= 1024 * 1024) return false;
      list.resize(list.size() * 2);
    }
    if (members->NumberOfProcessIdsInList > (list.size() - offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList)) / sizeof(ULONG_PTR))
      return false;
    std::vector<HANDLE> opened;
    std::unordered_set<uintptr_t> live;
    bool valid = true;
    rss = 0;
    for (DWORD i = 0; i < members->NumberOfProcessIdsInList; ++i) {
      HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE,
                                   FALSE, static_cast<DWORD>(members->ProcessIdList[i]));
      if (!process) {
        if (GetLastError() != ERROR_INVALID_PARAMETER) valid = false;
        continue;
      }
      opened.push_back(process);
    }
    std::vector<agnes_file_snapshot::Entry> rows;
    if (type && !snapshot(rows)) valid = false;
    for (HANDLE process : opened) {
      BOOL owned = FALSE;
      if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) { CloseHandle(process); continue; }
      PROCESS_MEMORY_COUNTERS memory{};
      if (!IsProcessInJob(process, job, &owned) || !owned ||
          !GetProcessMemoryInfo(process, &memory, sizeof(memory))) {
        if (WaitForSingleObject(process, 0) != WAIT_OBJECT_0) valid = false;
      }
      else { live.insert(GetProcessId(process)); rss += memory.WorkingSetSize; }
      CloseHandle(process);
    }
    files = type ? agnes_file_snapshot::count(rows, live, type) : 0;
    return valid;
  }
};
enum Cause { completed, cpuMs, wallMs, memoryBytes, outputBytes, processes, cancel, owner,
             residual, unavailable, cleanup };
static const char* names[] = {"completed", "cpuMs", "wallMs", "memoryBytes", "outputBytes", "processes",
                              "cancel", "owner", "residual", "unavailable", "cleanup"};
int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && (std::wstring(argv[1]) == L"--probe-files" || std::wstring(argv[1]) == L"--probe-files-low")) {
    bool restricted = std::wstring(argv[1]) == L"--probe-files-low";
    bool token = !restricted || lower_integrity();
    Files files;
    const bool supported = token && files.initialize();
    RevertToSelf();
    write_frame(std::string("{\"fileHandles\":") + (supported ? "true" : "false") +
      ",\"restrictedTokenApplied\":" + (token ? "true" : "false") + "}\n");
    return token ? 0 : 125;
  }
  if (argc < 8) return refuse("exec_runner_unavailable");
  uint64_t limits[5]{};
  for (int i = 0; i < 5; ++i) {
    wchar_t* end = nullptr;
    limits[i] = _wcstoui64(argv[i + 1], &end, 10);
    if (*argv[i + 1] == L'-' || *end || !limits[i] || limits[i] > 9007199254740991ULL)
      return refuse("exec_resource_bounds");
  }
  if (std::wstring(argv[6]) != L"five-limits") return refuse("exec_limit_openFiles_unsupported");
  if (limits[1] >= INFINITE ||
      limits[0] > static_cast<uint64_t>(std::numeric_limits<LONGLONG>::max()) / 10000 ||
      limits[3] > 64 * 1024 * 1024 || limits[4] > 65535) return refuse("exec_resource_bounds");
  Files sampler;
  uint32_t length = 0;
  if (!read_exact(&length, 4) || length > 1024 * 1024) return refuse("exec_runner_unavailable");
  std::vector<char> input(length);
  if (length && !read_exact(input.data(), length)) return refuse("exec_runner_unavailable");
  Handle job{CreateJobObjectW(nullptr, nullptr)}, port{CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1)}, done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  if (!job.value || !port.value || !done.value) return refuse("exec_runner_unavailable");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION ceiling{};
  ceiling.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_TIME |
    JOB_OBJECT_LIMIT_PROCESS_TIME | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
  ceiling.BasicLimitInformation.PerJobUserTimeLimit.QuadPart = static_cast<LONGLONG>(limits[0] * 10000);
  ceiling.BasicLimitInformation.PerProcessUserTimeLimit = ceiling.BasicLimitInformation.PerJobUserTimeLimit;
  ceiling.BasicLimitInformation.ActiveProcessLimit = static_cast<DWORD>(limits[4]);
  ceiling.ProcessMemoryLimit = ceiling.JobMemoryLimit = static_cast<SIZE_T>(limits[2]);
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{job.value, port.value};
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &ceiling, sizeof(ceiling)) ||
      !SetInformationJobObject(job.value, JobObjectAssociateCompletionPortInformation, &association, sizeof(association)))
    return refuse("exec_runner_unavailable");
  SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  Handle command_in, input_writer, out, out_writer, err, err_writer;
  if (!CreatePipe(&command_in.value, &input_writer.value, &inheritable, 0) ||
      !CreatePipe(&out.value, &out_writer.value, &inheritable, 0) ||
      !CreatePipe(&err.value, &err_writer.value, &inheritable, 0) ||
      !SetHandleInformation(input_writer.value, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(out.value, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(err.value, HANDLE_FLAG_INHERIT, 0)) return refuse("exec_runner_unavailable");
  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  std::vector<unsigned char> attributes(attribute_bytes);
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = command_in.value;
  startup.StartupInfo.hStdOutput = out_writer.value;
  startup.StartupInfo.hStdError = err_writer.value;
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  HANDLE inherited[] = {command_in.value, out_writer.value, err_writer.value};
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_bytes)) return refuse("exec_runner_unavailable");
  bool prepared = UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                            inherited, sizeof(inherited), nullptr, nullptr) != FALSE;
  std::wstring command;
  for (int i = 7; i < argc; ++i) { if (!command.empty()) command += L' '; command += quote(argv[i]); }
  PROCESS_INFORMATION child{};
  bool launched = prepared && CreateProcessW(argv[7], command.data(), nullptr, nullptr, TRUE,
    CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startup.StartupInfo, &child);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (!launched) return refuse("exec_runner_unavailable");
  Handle process{child.hProcess}, thread{child.hThread};
  if (!AssignProcessToJobObject(job.value, process.value)) {
    TerminateProcess(process.value, 125);
    if (WaitForSingleObject(process.value, 3000) != WAIT_OBJECT_0) return refuse("exec_cleanup_unknown");
    return refuse("exec_runner_unavailable");
  }
  command_in.close(); out_writer.close(); err_writer.close();
  uint64_t peak_files = 0, peak_rss = 0, peak_processes = 1, committed = 0, cpu = 0, gap = 0;
  if (!sampler.sample(job.value, peak_files, peak_rss)) {
    TerminateJobObject(job.value, 125);
    uint64_t deadline = GetTickCount64() + 3000;
    do {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
      if (QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &state, sizeof(state), nullptr) &&
          state.ActiveProcesses == 0) return refuse("exec_runner_unavailable");
      Sleep(10);
    } while (GetTickCount64() < deadline);
    return refuse("exec_cleanup_unknown");
  }
  std::atomic<int> cause{completed};
  auto interrupt = [&](Cause why) { int expected = completed; cause.compare_exchange_strong(expected, why); TerminateJobObject(job.value, 1); };
  std::mutex output_lock;
  std::vector<unsigned char> kept[2];
  uint64_t held = 0;
  std::atomic<uint64_t> raw{0};
  std::atomic<DWORD> io_ids[3]{};
  std::atomic<unsigned> io_finished{0};
  auto receive = [&](HANDLE stream, int index) {
    io_ids[index].store(GetCurrentThreadId());
    unsigned char buffer[4096]; DWORD n;
    while (ReadFile(stream, buffer, sizeof(buffer), &n, nullptr) && n) {
      const uint64_t total = raw.fetch_add(n) + n;
      { std::lock_guard<std::mutex> lock(output_lock);
        size_t keep = static_cast<size_t>(std::min<uint64_t>(n, limits[3] - held));
        kept[index].insert(kept[index].end(), buffer, buffer + keep); held += keep; }
      if (total > limits[3]) interrupt(outputBytes);
    }
    ++io_finished;
  };
  std::thread stdout_thread(receive, out.value, 0), stderr_thread(receive, err.value, 1);
  std::thread source([&] {
    io_ids[2].store(GetCurrentThreadId());
    size_t at = 0;
    while (at < input.size() && WaitForSingleObject(done.value, 0) == WAIT_TIMEOUT) {
      DWORD wrote = 0;
      if (!WriteFile(input_writer.value, input.data() + at,
          static_cast<DWORD>(input.size() - at), &wrote, nullptr) || !wrote) break;
      at += wrote;
    }
    input_writer.close();
    ++io_finished;
  });
  std::thread control([&] {
    while (WaitForSingleObject(done.value, 5) == WAIT_TIMEOUT) {
      DWORD available = 0;
      if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) {
        interrupt(owner); break;
      }
      if (available) { interrupt(cancel); break; }
    }
  });
  std::thread wall([&] { if (WaitForSingleObject(done.value, static_cast<DWORD>(limits[1])) == WAIT_TIMEOUT) interrupt(wallMs); });
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION initial_memory{};
  if (!QueryInformationJobObject(job.value, JobObjectExtendedLimitInformation, &initial_memory, sizeof(initial_memory), nullptr))
    interrupt(unavailable);
  else {
    committed = initial_memory.PeakJobMemoryUsed;
    if (committed > limits[2] || peak_rss > limits[2]) interrupt(memoryBytes);
  }
  if (cause.load() == completed && ResumeThread(thread.value) == static_cast<DWORD>(-1)) interrupt(unavailable);
  uint64_t last = GetTickCount64(), cleanup_begin = 0;
  bool verified = false;
  int remaining = -1;
  for (;;) {
    DWORD message; ULONG_PTR key; OVERLAPPED* value;
    while (GetQueuedCompletionStatus(port.value, &message, &key, &value, 0)) {
      if (key != reinterpret_cast<ULONG_PTR>(job.value)) { interrupt(unavailable); break; }
      if (message == JOB_OBJECT_MSG_END_OF_JOB_TIME || message == JOB_OBJECT_MSG_END_OF_PROCESS_TIME) interrupt(cpuMs);
      if (message == JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT || message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT) interrupt(memoryBytes);
      if (message == JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT) interrupt(processes);
    }
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION memory{};
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) ||
        !QueryInformationJobObject(job.value, JobObjectExtendedLimitInformation, &memory, sizeof(memory), nullptr)) {
      interrupt(unavailable);
    } else {
      cpu = static_cast<uint64_t>(accounting.TotalUserTime.QuadPart + accounting.TotalKernelTime.QuadPart) / 10000;
      committed = std::max<uint64_t>(committed, memory.PeakJobMemoryUsed);
      peak_processes = std::max<uint64_t>(peak_processes, accounting.ActiveProcesses);
      remaining = static_cast<int>(accounting.ActiveProcesses);
      if (cpu >= limits[0]) interrupt(cpuMs);
      if (!remaining) { gap = std::max(gap, GetTickCount64() - last); verified = true; break; }
      if (WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0) interrupt(residual);
      uint64_t files = 0, rss = 0;
      if (!sampler.sample(job.value, files, rss)) interrupt(unavailable);
      else {
        peak_files = std::max(peak_files, files); peak_rss = std::max(peak_rss, rss);
        if (rss > limits[2]) interrupt(memoryBytes);
      }
    }
    uint64_t now = GetTickCount64(); gap = std::max(gap, now - last); last = now;
    if (cause.load() != completed) {
      TerminateJobObject(job.value, 1);
      if (!cleanup_begin) cleanup_begin = now;
      if (now - cleanup_begin > 3000) { cause.store(cleanup); remaining = -1; break; }
    }
    Sleep(10);
  }
  SetEvent(done.value);
  control.join(); wall.join();
  uint64_t drain_started = GetTickCount64();
  while (io_finished.load() != 3) {
    if (GetTickCount64() - drain_started > 100) for (auto& id : io_ids) {
      Handle worker{OpenThread(THREAD_TERMINATE, FALSE, id.load())};
      if (worker.value) CancelSynchronousIo(worker.value);
    }
    // A pipe held outside the owned Job must not wedge cleanup or produce completion.
    if (GetTickCount64() - drain_started > 3000) ExitProcess(125);
    Sleep(5);
  }
  source.join(); stdout_thread.join(); stderr_thread.join();
  DWORD exit = 0; GetExitCodeProcess(process.value, &exit);
  const char* digits = "0123456789abcdef";
  for (int stream = 0; stream < 2; ++stream) for (size_t at = 0; at < kept[stream].size(); at += 1024) {
    std::string hex;
    for (size_t i = at; i < std::min(at + 1024, kept[stream].size()); ++i) { unsigned char b = kept[stream][i]; hex += digits[b >> 4]; hex += digits[b & 15]; }
    write_frame("{\"kind\":\"output\",\"stream\":" + std::to_string(stream) + ",\"hex\":\"" + hex + "\"}\n");
  }
  write_frame("{\"kind\":\"metrics\",\"pid\":" + std::to_string(child.dwProcessId) + ",\"final\":true,\"reason\":\"" + names[cause.load()] +
    "\",\"code\":" + std::to_string(static_cast<int32_t>(exit)) + ",\"signal\":0,\"cpuMs\":" + std::to_string(cpu) +
    ",\"rss\":" + std::to_string(peak_rss) + ",\"committedBytes\":" + std::to_string(committed) + ",\"processes\":" + std::to_string(peak_processes) +
    ",\"files\":" + std::to_string(peak_files) + ",\"filesEnforced\":false" +
    ",\"outputBytes\":" + std::to_string(raw.load()) + ",\"intervalMs\":10,\"maxGapMs\":" + std::to_string(gap) +
    ",\"remaining\":" + std::to_string(remaining) + ",\"ownershipVerified\":" + (verified ? "true" : "false") +
    ",\"residualObserved\":0,\"ownership\":\"strong\"}\n");
  return verified ? 0 : 125;
}
