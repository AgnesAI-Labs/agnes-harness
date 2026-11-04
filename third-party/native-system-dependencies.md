# Native runtime dependencies

The Linux `@agnes/system-node` addon uses EVP SHA-256 from the Node process that loads it.
It includes the OpenSSL headers supplied alongside `node_api.h` in the matching Node headers,
leaves EVP references unresolved in the shared addon, and resolves them from Node at load/use time.
There is no separately linked or bundled `libcrypto`, OpenSSL source, or OpenSSL license payload.
The Node distribution owns its OpenSSL version, security updates and notices.

Hashing still reads the verified, already opened private artifact before deleting its revalidated
inode. It does not require the optional AF_ALG kernel interface, which container seccomp may deny.
The runtime probe checks digest match/mismatch, empty and multi-block input, plain Node, worker
threads and an injected SEA executable built from the pinned official Node binary.

Linux development builds use the host compiler and matching Node headers, without Docker or system
OpenSSL development packages. For portable CI, release or eval artifacts, explicitly select
`AGNES_NATIVE_BUILDER=glibc228`: `tools/native/Dockerfile` uses a glibc 2.28 build-only sysroot.
No sysroot libraries are copied into the output. Native development builds warn on newer GLIBC
imports; opted-in compatibility builds and all local/SEA distribution staging reject them.
The artifact scanner walks the complete output, including third-party `.node`, shared libraries,
Node and helper executables, and rejects private/unknown version tags or an empty ELF scan.
