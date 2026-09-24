#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <delayimp.h>
#include <cstring>

// Match node-gyp's renamed-host strategy without searching for a second Node image.
// This distribution embeds Node in the executable, including the SEA entry point.
static FARPROC WINAPI resolve_node_host(unsigned event, DelayLoadInfo* import) {
  if (event != dliNotePreLoadLibrary || _stricmp(import->szDll, "node.exe") != 0)
    return nullptr;
  return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
}

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = resolve_node_host;
