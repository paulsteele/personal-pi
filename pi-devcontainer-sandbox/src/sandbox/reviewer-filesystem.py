import json
import pathlib
import sys

MAX_REQUEST_BYTES = 256 * 1024
MAX_PATHS_PER_REQUEST = 32


def canonical_path(path):
    if not isinstance(path, str) or len(path) > 4096 or "\0" in path:
        raise ValueError("Invalid reviewer path")
    candidate = pathlib.Path(path)
    if not candidate.is_absolute():
        candidate = pathlib.Path.cwd() / candidate
    return str(candidate.resolve(strict=False))


def handle_request(request):
    operation = request.get("operation")
    if operation == "ready":
        return True
    if operation == "canonical_paths":
        paths = request.get("paths")
        if not isinstance(paths, list) or len(paths) > MAX_PATHS_PER_REQUEST:
            raise ValueError("Invalid reviewer path batch")
        return [canonical_path(path) for path in paths]
    raise ValueError("Unsupported reviewer filesystem operation")


while True:
    line = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
    if not line:
        break
    if len(line) > MAX_REQUEST_BYTES or not line.endswith(b"\n"):
        raise ValueError("Reviewer request exceeds transport limit")
    request = json.loads(line)
    request_id = request.get("id")
    if not isinstance(request_id, int) or isinstance(request_id, bool) or request_id < 1:
        raise ValueError("Invalid reviewer request identity")
    try:
        response = {"id": request_id, "result": handle_request(request)}
    except (ValueError, OSError, RuntimeError) as error:
        response = {"id": request_id, "error": str(error)}
    print(json.dumps(response), flush=True)
