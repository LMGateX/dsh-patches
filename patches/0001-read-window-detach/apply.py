#!/usr/bin/env python3
"""Apply or revert one exact, version- and SHA-256-guarded local DSH patch."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def discover_root():
    configured = os.environ.get("DSH_ROOT")
    if configured:
        return configured
    return str(Path(subprocess.check_output(
        ["npm", "root", "-g"], text=True).strip()) / "@deepseek-ai/dsh")


def read_manifest():
    meta = json.loads((HERE / "manifest.json").read_text())
    if not re.fullmatch(r"[a-z0-9-]+", meta["id"]):
        raise ValueError("Invalid patch identifier")
    for field in ("originalSha256", "patchedSha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", meta[field]):
            raise ValueError("Invalid manifest hash")
    return meta


def check_package(path, name, version):
    package = json.loads(path.read_text())
    if (package.get("name"), package.get("version")) != (name, version):
        raise ValueError("Unsupported package name/version; refusing modification")


def exact_hunk(data):
    lines = (HERE / "fix.patch").read_text().splitlines(keepends=True)
    if len(lines) < 4 or not lines[0].startswith("--- ") or not lines[1].startswith("+++ "):
        raise ValueError("Expected one unified diff")
    if not lines[2].startswith("@@ "):
        raise ValueError("Expected one patch hunk")
    hunk = lines[3:]
    if any(not line or line[0] not in " +-" for line in hunk):
        raise ValueError("Only one exact hunk is supported")
    before = "".join(line[1:] for line in hunk if line[0] in " -")
    after = "".join(line[1:] for line in hunk if line[0] in " +")
    source = data.decode("utf-8")
    if not before or source.count(before) != 1:
        raise ValueError("Patch context does not match exactly once")
    return source.replace(before, after, 1).encode("utf-8")


def replace_atomically(target, data, info):
    # target is already canonical and confined to the explicitly selected root.
    fd, name = tempfile.mkstemp(prefix=".dsh-patch-", dir=target.parent)
    temporary = Path(name).resolve()
    if temporary.parent != target.parent or not temporary.name.startswith(".dsh-patch-"):
        os.close(fd)
        raise ValueError("Unexpected temporary path")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, stat.S_IMODE(info.st_mode))
        if os.geteuid() == 0:
            os.chown(temporary, info.st_uid, info.st_gid)
        # Both resolved endpoints were checked above; no computed delete/move
        # operates outside the selected package directory.
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            if temporary.parent != target.parent or not temporary.name.startswith(".dsh-patch-"):
                raise ValueError("Unexpected cleanup path")
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", help="Installed @deepseek-ai/dsh directory")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--revert", action="store_true")
    args = parser.parse_args()
    meta = read_manifest()
    root = Path(args.root or discover_root()).expanduser().resolve(strict=True)
    relative = Path(meta["target"])
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Invalid target path")
    target = (root / relative).resolve(strict=True)
    if not target.is_relative_to(root) or not target.is_file():
        raise ValueError("Target is outside the selected package root")
    check_package(root / "package.json", meta["package"], meta["version"])
    check_package(target.parent.parent / "package.json", meta["targetPackage"], meta["targetVersion"])
    info = target.stat()
    current = target.read_bytes()
    current_hash = digest(current)
    original_hash, patched_hash = meta["originalSha256"], meta["patchedSha256"]
    if current_hash not in (original_hash, patched_hash):
        raise ValueError("Unknown source SHA-256; refusing to patch or overwrite another modification")
    state = "applied" if current_hash == patched_hash else "unapplied"
    if args.check:
        print(json.dumps({"patch": meta["id"], "state": state, "sha256": current_hash}))
        return
    backup = root / ".local-patch-backups" / meta["id"] / original_hash / "index.js.original"
    if not backup.resolve().is_relative_to(root):
        raise ValueError("Backup escapes the selected package root")
    if args.apply:
        if state == "applied":
            print("Already applied; no files changed.")
            return
        updated = exact_hunk(current)
        if digest(updated) != patched_hash:
            raise ValueError("Patched SHA-256 does not match the tested build")
        backup.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if backup.exists():
            if digest(backup.read_bytes()) != original_hash:
                raise ValueError("Existing backup does not match the original")
        else:
            fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(current)
                handle.flush()
                os.fsync(handle.fileno())
        # Refuse changes made since validation (e.g. a package update).
        if target.read_bytes() != current:
            raise ValueError("Target changed during validation; refusing replacement")
        replace_atomically(target, updated, info)
        if digest(target.read_bytes()) != patched_hash:
            raise RuntimeError("Installed file verification failed")
        print(json.dumps({"patch": meta["id"], "state": "applied", "sha256": patched_hash}))
        print("Original source backed up locally. Restart DSH normally to load the patch; no process was restarted.")
    else:
        if state == "unapplied":
            print("Already unapplied; no files changed.")
            return
        original = backup.read_bytes()
        if digest(original) != original_hash:
            raise ValueError("Backup SHA-256 mismatch; refusing rollback")
        if target.read_bytes() != current:
            raise ValueError("Target changed during validation; refusing replacement")
        replace_atomically(target, original, info)
        print(json.dumps({"patch": meta["id"], "state": "unapplied", "sha256": original_hash}))
        print("Original source restored. Restart DSH normally; no process was restarted.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print("ERROR: " + str(error), file=sys.stderr)
        sys.exit(2)
