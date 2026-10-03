#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstdio>
#include <string>
#include <vector>
static void record(const wchar_t* path) {
  HANDLE file = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, 0, nullptr);
  if (file == INVALID_HANDLE_VALUE) ExitProcess(90);
  auto row = std::to_string(GetCurrentProcessId()) + "\n"; DWORD n;
  if (!WriteFile(file, row.data(), static_cast<DWORD>(row.size()), &n, nullptr)) ExitProcess(91);
  CloseHandle(file);
}
static bool child(const wchar_t* mode, const wchar_t* trace, DWORD flags = 0) {
  wchar_t executable[32768]; if (!GetModuleFileNameW(nullptr, executable, 32768)) ExitProcess(92);
  std::wstring line = L"\"" + std::wstring(executable) + L"\" " + mode + L" \"" + trace + L"\"";
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION created{};
  if (!CreateProcessW(executable, line.data(), nullptr, nullptr, FALSE, flags, nullptr, nullptr, &startup, &created)) return false;
  CloseHandle(created.hThread); CloseHandle(created.hProcess); return true;
}
int wmain(int argc, wchar_t** argv) {
  if (argc < 3) return 93;
  record(argv[2]);
  std::wstring mode(argv[1]);
  if (mode == L"leaf") {
    for (DWORD id : {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE}) CloseHandle(GetStdHandle(id));
    Sleep(INFINITE);
  } else if (mode == L"descendants" || mode == L"family") {
    if (!child(L"leaf", argv[2])) return 94;
    if (mode == L"family") Sleep(INFINITE);
    Sleep(250); return 0;
  } else if (mode == L"breakaway") {
    printf("%s", child(L"leaf", argv[2], CREATE_BREAKAWAY_FROM_JOB) ? "escaped" : "blocked");
  } else if (mode == L"cpu") {
    volatile unsigned long long work = 0;
    for (;;) work = work * 1664525 + 1013904223;
  } else if (mode == L"memory") {
    for (;;) {
      auto page = static_cast<unsigned char*>(VirtualAlloc(nullptr, 4194304, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
      if (!page) { Sleep(INFINITE); break; }
      for (size_t offset = 0; offset < 4194304; offset += 4096) page[offset] = 42;
      Sleep(5);
    }
  } else if (mode == L"processes") {
    while (child(L"leaf", argv[2])) Sleep(1);
    Sleep(INFINITE);
  } else if (mode == L"files" || mode == L"events") {
    std::vector<HANDLE> held;
    for (int batch = 0; batch != 200; ++batch) {
      for (int index = 0; index != 100; ++index) {
        HANDLE h = mode == L"files"
          ? CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr)
          : CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!h || h == INVALID_HANDLE_VALUE) return 95;
        held.push_back(h);
      }
      Sleep(1);
    }
    if (mode == L"files") Sleep(INFINITE);
    else { printf("events-held"); Sleep(100); }
  } else if (mode == L"output") {
    std::string block(4096, 'x');
    for (;;) { DWORD n; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), block.data(), 4096, &n, nullptr); }
  } else if (mode == L"wall") Sleep(INFINITE);
  else return 96;
  return 0;
}
