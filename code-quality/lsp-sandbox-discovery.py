import collections
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

options = json.load(sys.stdin)
root = pathlib.Path(options["root"]).resolve(strict=True)
excluded = set(options["excludedDirectories"])
source_extensions = set(options["sourceExtensions"])
project_markers = set(options["projectMarkers"])
remaining = options["entryLimit"]
files = []
truncated = False


def consume_entry():
    global remaining, truncated
    if remaining <= 0:
        truncated = True
        return False
    remaining -= 1
    return True


def priority(candidate):
    file, submodule = candidate
    path = pathlib.PurePosixPath(file)
    is_source = path.suffix in source_extensions
    is_marker = path.name in project_markers or re.search(r"\.(csproj|slnx?)$", file)
    if is_source or is_marker:
        return (0, file)
    if submodule:
        return (1, file)
    return (2, file)


def git_candidates(directory):
    try:
        result = subprocess.run(
            ["git", "ls-files", "--stage", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=directory, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
            capture_output=True, timeout=10, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    entries = {}
    for entry in result.stdout.decode("utf-8").split("\0"):
        if not entry:
            continue
        metadata = re.match(r"(\d{6}) [a-f0-9]+ [0-3]\t", entry)
        file = entry[metadata.end():] if metadata else entry
        submodule = metadata is not None and metadata.group(1) == "160000"
        entries[file] = entries.get(file, False) or submodule
    return sorted(entries.items(), key=priority)


def discover_directory(directory):
    directories = collections.deque([directory])
    while directories:
        current = directories.popleft()
        with os.scandir(current) as entries:
            candidates = sorted(entries, key=lambda entry: entry.name)
        for entry in candidates:
            if not consume_entry():
                return
            if entry.is_symlink():
                continue
            path = pathlib.Path(entry.path)
            if entry.is_dir(follow_symlinks=False) and entry.name not in excluded:
                directories.append(path)
            elif entry.is_file(follow_symlinks=False):
                files.append(path.relative_to(root).as_posix())


def discover(directory):
    candidates = git_candidates(directory)
    if candidates is None:
        discover_directory(directory)
        return
    for file, submodule in candidates:
        relative = pathlib.PurePosixPath(file)
        if any(part in excluded for part in relative.parts[:-1]):
            continue
        if not consume_entry():
            return
        path = directory / file
        if not path.is_relative_to(root) or path.resolve() != path or path.is_symlink():
            continue
        if path.is_file():
            files.append(path.relative_to(root).as_posix())
        elif submodule and path.is_dir() and path.name not in excluded:
            git_entry = path / ".git"
            if git_entry.exists() and not git_entry.is_symlink():
                discover(path)
                if truncated:
                    return


discover(root)
result = {"files": sorted(set(files)), "truncated": truncated}
if options.get("includeManifestRevision"):
    manifest_hash = hashlib.sha256()
    for file in result["files"]:
        path = pathlib.PurePosixPath(file)
        is_manifest = path.name in project_markers or re.search(r"\.(csproj|slnx?)$", file)
        if not is_manifest:
            continue
        stat = (root / file).stat()
        manifest_hash.update(f"{file}:{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}".encode())
    result["manifestRevision"] = manifest_hash.hexdigest()
json.dump(result, sys.stdout)
