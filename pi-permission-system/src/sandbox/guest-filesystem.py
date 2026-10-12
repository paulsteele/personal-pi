import base64
import glob
import json
import mimetypes
import os
import pathlib
import stat
import sys

def canonicalize_path(requested_path, cwd):
    candidate = pathlib.Path(os.path.expanduser(requested_path))
    if not candidate.is_absolute():
        candidate = pathlib.Path(cwd) / candidate
    return candidate.resolve(strict=False)


request = json.load(sys.stdin)
operation = request["operation"]
path = canonicalize_path(request["path"], request["cwd"])

if operation == "canonical":
    result = str(path)
elif operation == "canonical_paths":
    result = [str(canonicalize_path(requested_path, request["cwd"])) for requested_path in request["paths"]]
elif operation == "entries_exist":
    result = []
    for requested_path in request["paths"]:
        entry_path = os.path.join(request["cwd"], requested_path)
        entry_exists = os.path.lexists(entry_path)
        result.append(entry_exists)
elif operation == "read":
    result = base64.b64encode(path.read_bytes()).decode("ascii")
elif operation == "write":
    path.write_bytes(base64.b64decode(request["content"]))
    result = None
elif operation == "mkdir":
    path.mkdir(parents=True, exist_ok=True)
    result = None
elif operation == "stat":
    metadata = path.stat()
    result = {
        "directory": stat.S_ISDIR(metadata.st_mode),
        "file": stat.S_ISREG(metadata.st_mode),
        "size": metadata.st_size,
        "identity": str(metadata.st_dev) + ":" + str(metadata.st_ino),
    }
elif operation == "list":
    result = sorted(os.listdir(path))
elif operation == "glob":
    result = sorted(glob.glob(request["pattern"], root_dir=str(path), recursive=True))[:request["limit"]]
elif operation == "access":
    if not os.access(path, os.R_OK):
        raise PermissionError(str(path))
    result = None
elif operation == "mime":
    result = mimetypes.guess_type(str(path))[0]
else:
    raise ValueError("Unsupported filesystem operation")

json.dump(result, sys.stdout)
