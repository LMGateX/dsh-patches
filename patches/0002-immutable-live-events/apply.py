#!/usr/bin/env python3
"""Guarded two-file installer. Does not stop or restart DSH."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

HERE = Path(__file__).resolve().parent

def digest(data):
    return hashlib.sha256(data).hexdigest()

def patch_sections():
    sections = {}
    current = None
    lines = (HERE / "fix.patch").read_text().splitlines(keepends=True)
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("--- a/"):
            name = line[6:].rstrip("\n")
            i += 1
            if name in sections or i >= len(lines) or lines[i] != "+++ b/" + name + "\n":
                raise ValueError("Invalid or duplicate patch target")
            current = []
            sections[name] = current
        elif line.startswith("@@ "):
            if current is None:
                raise ValueError("Hunk without target")
            current.append([])
        else:
            if not current or not line or line[0] not in " +-":
                raise ValueError("Invalid patch content")
            current[-1].append(line)
        i += 1
    return sections

def transform(data, hunks, reverse=False):
    source = data.decode("utf-8")
    for hunk in reversed(hunks) if reverse else hunks:
        before = "".join(line[1:] for line in hunk if line[0] in (" +" if reverse else " -"))
        after = "".join(line[1:] for line in hunk if line[0] in (" -" if reverse else " +"))
        if not before or source.count(before) != 1:
            raise ValueError("Patch context does not match exactly once")
        source = source.replace(before, after, 1)
    return source.encode("utf-8")

def stage(path, data, metadata):
    fd, name = tempfile.mkstemp(prefix=".dsh-patch-0002-", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), stat.S_IMODE(metadata.st_mode))
            os.fchown(stream.fileno(), metadata.st_uid, metadata.st_gid)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        cleanup(temp, path.parent)
        raise
    return temp

def cleanup(temp, parent):
    if temp.exists():
        if temp.parent.resolve() != parent.resolve() or not temp.name.startswith(".dsh-patch-0002-"):
            raise ValueError("Refusing unexpected temporary path")
        temp.unlink()

def replace(temp, path):
    if temp.parent.resolve() != path.parent.resolve() or not temp.name.startswith(".dsh-patch-0002-"):
        raise ValueError("Refusing unexpected staged path")
    if path.resolve() != path or not path.is_file():
        raise ValueError("Target identity changed")
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="DSH package root")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--apply", action="store_true")
    actions.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    manifest = json.loads((HERE / "manifest.json").read_text())
    if manifest["id"] != "0002-immutable-live-events":
        raise ValueError("Unexpected patch id")
    package = json.loads((root / "package.json").read_text())
    if package["name"] != "@deepseek-ai/dsh" or package["version"] != manifest["dshVersion"]:
        raise ValueError("Unsupported DSH package")
    sections = patch_sections()
    targets = manifest["targets"]
    if len(targets) != 2 or set(sections) != {t["path"] for t in targets}:
        raise ValueError("Expected exactly the reviewed two-file patch")
    plans = []
    for target in targets:
        relative = Path(target["path"])
        path = root / relative
        if relative.is_absolute() or ".." in relative.parts or path.resolve() != path or root not in path.parents:
            raise ValueError("Unsafe target path")
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("Target is not a regular file")
        dependency = json.loads((path.parent.parent / "package.json").read_text())
        if dependency["name"] != target["package"] or dependency["version"] != target["version"]:
            raise ValueError("Unsupported dependency package")
        data = path.read_bytes()
        checksum = digest(data)
        state = "original" if checksum == target["originalSha256"] else "patched" if checksum == target["patchedSha256"] else "unknown"
        if state == "unknown":
            raise ValueError("Unsupported full source hash: " + target["name"])
        original = data if state == "original" else transform(data, sections[target["path"]], True)
        patched = transform(original, sections[target["path"]])
        if digest(original) != target["originalSha256"] or digest(patched) != target["patchedSha256"]:
            raise ValueError("Exact patch fingerprint mismatch")
        backup = root / ".local-patch-backups" / manifest["id"] / target["originalSha256"] / (target["path"] + ".original")
        plans.append(dict(target=target, path=path, metadata=metadata, before=data, original=original, patched=patched, state=state, backup=backup))
    states = {p["state"] for p in plans}
    if len(states) != 1:
        raise ValueError("Mixed installation state; inspect before changing files")
    action = "apply" if args.apply else "rollback" if args.rollback else "check"
    desired = "patched" if args.apply else "original"
    if action == "check" or states == {desired}:
        print(json.dumps({"action": action, "changed": False, "targets": [{"name": p["target"]["name"], "state": p["state"]} for p in plans]}))
        return
    for p in plans:
        backup = p["backup"]
        if args.apply:
            backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not backup.exists():
                fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(p["original"])
                    stream.flush()
                    os.fsync(stream.fileno())
        if backup.read_bytes() != p["original"]:
            raise ValueError("Missing or mismatched original backup")
        p["output"] = p["patched"] if args.apply else p["original"]
    staged = []
    applied = []
    try:
        for p in plans:
            p["temp"] = stage(p["path"], p["output"], p["metadata"])
            staged.append(p)
        for p in plans:
            if p["path"].read_bytes() != p["before"]:
                raise ValueError("Source changed during installation")
        for p in plans:
            if p["path"].read_bytes() != p["before"]:
                raise ValueError("Source changed before replacement")
            applied.append(p)
            replace(p["temp"], p["path"])
        for p in plans:
            if p["path"].read_bytes() != p["output"]:
                raise ValueError("Installed output verification failed")
    except BaseException:
        failures = []
        for p in reversed(applied):
            try:
                current = p["path"].read_bytes()
                if current == p["before"]:
                    continue
                if current != p["output"]:
                    raise ValueError("Concurrent change prevents rollback")
                restore = stage(p["path"], p["before"], p["metadata"])
                replace(restore, p["path"])
            except BaseException as error:
                failures.append(p["target"]["name"] + ": " + str(error))
        if failures:
            print("ROLLBACK INCOMPLETE: " + "; ".join(failures), file=sys.stderr)
        raise
    finally:
        for p in staged:
            cleanup(p["temp"], p["path"].parent)
    print(json.dumps({"action": action, "changed": True, "targets": [{"name": p["target"]["name"], "sha256": digest(p["path"].read_bytes()), "backup": str(p["backup"])} for p in plans], "restartPerformed": False}))

if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        print("Refused or failed safely: " + str(error), file=sys.stderr)
        sys.exit(2)
