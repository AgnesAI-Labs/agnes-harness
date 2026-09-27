"""Test-only ConPTY driver; no shell, dependencies, or production approval bypass."""

import argparse
import ctypes as c
from ctypes import wintypes as w
import queue
import subprocess
import sys
import threading
import time


class Coord(c.Structure):
    _fields_ = [("X", c.c_short), ("Y", c.c_short)]


class Startup(c.Structure):
    _fields_ = [
        ("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR),
        ("title", w.LPWSTR), ("x", w.DWORD), ("y", w.DWORD),
        ("xSize", w.DWORD), ("ySize", w.DWORD), ("xChars", w.DWORD),
        ("yChars", w.DWORD), ("fill", w.DWORD), ("flags", w.DWORD),
        ("show", w.WORD), ("reservedSize", w.WORD), ("reservedBytes", c.c_void_p),
        ("stdin", w.HANDLE), ("stdout", w.HANDLE), ("stderr", w.HANDLE),
    ]


class StartupEx(c.Structure):
    _fields_ = [("startup", Startup), ("attributes", c.c_void_p)]


class ProcessInfo(c.Structure):
    _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE),
                ("pid", w.DWORD), ("tid", w.DWORD)]


def run(args):
    kernel = c.WinDLL("kernel32", use_last_error=True)

    def api(name, result, *parameters):
        function = getattr(kernel, name)
        function.restype = result
        function.argtypes = parameters
        return function

    pointer = c.c_void_p
    close = api("CloseHandle", w.BOOL, w.HANDLE)
    pipe = api("CreatePipe", w.BOOL, c.POINTER(w.HANDLE), c.POINTER(w.HANDLE), pointer, w.DWORD)
    create_console = api("CreatePseudoConsole", c.c_long, Coord, w.HANDLE, w.HANDLE, w.DWORD, c.POINTER(w.HANDLE))
    close_console = api("ClosePseudoConsole", None, w.HANDLE)
    initialize = api("InitializeProcThreadAttributeList", w.BOOL, pointer, w.DWORD, w.DWORD, c.POINTER(c.c_size_t))
    update = api("UpdateProcThreadAttribute", w.BOOL, pointer, w.DWORD, c.c_size_t, pointer, c.c_size_t, pointer, pointer)
    delete = api("DeleteProcThreadAttributeList", None, pointer)
    create = api("CreateProcessW", w.BOOL, w.LPCWSTR, w.LPWSTR, pointer, pointer, w.BOOL, w.DWORD, pointer, w.LPCWSTR, pointer, c.POINTER(ProcessInfo))
    read = api("ReadFile", w.BOOL, w.HANDLE, pointer, w.DWORD, c.POINTER(w.DWORD), pointer)
    write = api("WriteFile", w.BOOL, w.HANDLE, pointer, w.DWORD, c.POINTER(w.DWORD), pointer)
    wait = api("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
    exit_code = api("GetExitCodeProcess", w.BOOL, w.HANDLE, c.POINTER(w.DWORD))

    def check(ok):
        if not ok:
            raise c.WinError(c.get_last_error())

    handles = []
    console = w.HANDLE()
    attributes = None
    reader = None
    messages = queue.Queue()
    output = bytearray()
    info = ProcessInfo()
    result = 124
    replied = False

    def capture(handle):
        try:
            buffer = c.create_string_buffer(8192)
            count = w.DWORD()
            while read(handle, buffer, len(buffer), c.byref(count), None):
                if not count.value:
                    break
                messages.put(buffer.raw[:count.value])
        finally:
            messages.put(None)

    try:
        input_read, input_write = w.HANDLE(), w.HANDLE()
        check(pipe(c.byref(input_read), c.byref(input_write), None, 0))
        handles.extend([input_read, input_write])
        output_read, output_write = w.HANDLE(), w.HANDLE()
        check(pipe(c.byref(output_read), c.byref(output_write), None, 0))
        handles.extend([output_read, output_write])
        hr = create_console(Coord(240, 40), input_read, output_write, 0, c.byref(console))
        if hr < 0:
            raise OSError(f"CreatePseudoConsole failed: HRESULT {hr & 0xffffffff:08x}")
        size = c.c_size_t()
        initialize(None, 1, 0, c.byref(size))
        storage = c.create_string_buffer(size.value)
        check(initialize(storage, 1, 0, c.byref(size)))
        attributes = storage
        check(update(storage, 0, 0x00020016, console, c.sizeof(console), None, None))
        startup = StartupEx()
        startup.startup.cb = c.sizeof(startup)
        # Null standard handles request console handles even when this driver is piped.
        startup.startup.flags = 0x00000100
        startup.attributes = c.cast(storage, pointer)
        command = c.create_unicode_buffer(subprocess.list2cmdline(args.command))
        check(create(args.command[0], command, None, None, False, 0x00080000,
                     None, None, c.byref(startup), c.byref(info)))
        handles.extend([info.process, info.thread])
        reader = threading.Thread(target=capture, args=(output_read,), daemon=True)
        reader.start()
        for handle in [input_read, output_write]:
            close(handle)
            handles.remove(handle)
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            try:
                chunk = messages.get(timeout=0.02)
                if chunk:
                    output.extend(chunk)
            except queue.Empty:
                pass
            if len(output) > 4 * 1024 * 1024:
                raise RuntimeError("ConPTY output exceeded 4 MiB")
            if args.expect and not replied and args.expect.encode() in output:
                payload = (args.reply + "\r").encode("utf8")
                count = w.DWORD()
                check(write(input_write, payload, len(payload), c.byref(count), None))
                if count.value != len(payload):
                    raise RuntimeError("Incomplete console input")
                replied = True
            state = wait(info.process, 0)
            if state == 0:
                code = w.DWORD()
                check(exit_code(info.process, c.byref(code)))
                result = code.value
                break
            if state == 0xffffffff:
                check(False)
    finally:
        # Keep the output reader active while closing; ConPTY can emit a final frame.
        for handle in [input_read, locals().get("output_write")]:
            if handle in handles:
                close(handle)
                handles.remove(handle)
        if console:
            close_console(console)
        if reader:
            reader.join(timeout=5)
        if attributes is not None:
            delete(attributes)
        for handle in reversed(handles):
            close(handle)
        while not messages.empty():
            chunk = messages.get_nowait()
            if chunk:
                output.extend(chunk)
        sys.stdout.buffer.write(output)
        sys.stdout.buffer.flush()
    if reader and reader.is_alive():
        raise RuntimeError("ConPTY reader did not finish")
    if args.expect and not replied:
        print("ConPTY expected prompt was not observed", file=sys.stderr)
        return 125 if result == 0 else result
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=45)
    parser.add_argument("--expect", default="")
    parser.add_argument("--reply", default="y")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    if options.command and options.command[0] == "--":
        options.command.pop(0)
    if sys.platform != "win32" or not options.command or options.timeout <= 0:
        parser.error("Windows, a command, and a positive timeout are required")
    sys.exit(run(options))
