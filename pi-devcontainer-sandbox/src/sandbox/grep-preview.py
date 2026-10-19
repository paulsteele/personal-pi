import json
import subprocess
import sys
import threading

MAX_PREVIEW_BYTES = 1024 * 1024

request = json.load(sys.stdin)
arguments = request["arguments"]
match_limit = request["limit"]
process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
assert process.stdout is not None
assert process.stderr is not None
MAX_STDERR_BYTES = 16000
stderr_preview = bytearray()


def capture_stderr_preview():
    assert process.stderr is not None
    while True:
        data = process.stderr.read(4096)
        if not data:
            return
        remaining_preview_bytes = MAX_STDERR_BYTES - len(stderr_preview)
        stderr_preview.extend(data[:remaining_preview_bytes])


stderr_preview_reader = threading.Thread(target=capture_stderr_preview)
stderr_preview_reader.start()
json_output_lines = []
truncated = False
try:
    match_count = 0
    preview_bytes = 0
    while True:
        remaining_preview_bytes = MAX_PREVIEW_BYTES - preview_bytes
        raw_line = process.stdout.readline(remaining_preview_bytes + 1)
        if not raw_line:
            break
        preview_bytes += len(raw_line)
        if preview_bytes > MAX_PREVIEW_BYTES:
            truncated = True
            process.terminate()
            break
        line = raw_line.decode("utf8", errors="replace").rstrip("\n")
        json_output_lines.append(line)
        if line.startswith("{"):
            record = json.loads(line)
            if record.get("type") == "match":
                match_count += 1
        if match_count >= match_limit:
            truncated = True
            process.terminate()
            break
    process.wait(timeout=2)
except subprocess.TimeoutExpired:
    process.kill()
    process.wait()
finally:
    if process.poll() is None:
        process.kill()
        process.wait()

stderr_preview_reader.join()
stderr = stderr_preview.decode("utf8", errors="replace")
preview_lines = []
for json_line in json_output_lines:
    record = json.loads(json_line)
    if record.get("type") not in ("match", "context"):
        continue
    data = record["data"]
    path = data["path"].get("text", "")
    text = data["lines"].get("text", "").rstrip("\n")
    separator = ":" if record["type"] == "match" else "-"
    preview_lines.append(f"{path}{separator}{data['line_number']}{separator}{text}")
result = {"output": "\n".join(preview_lines), "stderr": stderr, "code": 0 if truncated else process.returncode, "truncated": truncated}
json.dump(result, sys.stdout)
