# Rejected npm archive fixtures

npm-symlink.tgz and npm-hardlink.tgz are deterministic USTAR/gzip test archives. Both contain package/package.json for @agnes/base 1.2.3 and package/escape pointing to ../../outside. The second entry is respectively a symbolic link (type 2) or a hard link (type 1).

Generated with Python standard-library tarfile (USTAR_FORMAT) and gzip.compress(..., mtime=0), using TarInfo default uid/gid/mtime, manifest mode 0644, link mode 0777. Manifest bytes are exactly:

    {"name":"@agnes/base","version":"1.2.3","dependencies":{}}

Use tar -tvzf to inspect entry types without extracting. sources.test.ts passes these bytes through real archive validation and expects rejection before extraction. No Python runtime or symlink-creation privilege is required to run the tests. These fixtures do not prove filesystem symlink handling.
