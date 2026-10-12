import base64
import json
import os
import socket
import sys
import threading

socket_path, token, invocation, command, environment_names = sys.argv[1:6]
arguments = sys.argv[6:]
connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
connection.connect(socket_path)
writer = connection.makefile("wb", buffering=0)
write_lock = threading.Lock()
input_acknowledged = threading.Event()
input_closed = threading.Event()


def send(message):
    encoded = (json.dumps(message) + "\n").encode()
    with write_lock:
        writer.write(encoded)


send({
    "type": "start",
    "token": token,
    "invocation": int(invocation),
    "command": command,
    "args": arguments,
    "cwd": os.getcwd(),
    "environment": {name: os.environ[name] for name in json.loads(environment_names) if name in os.environ},
})


def forward_input():
    try:
        while not input_closed.is_set():
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                send({"type": "stdin_end"})
                return
            input_acknowledged.clear()
            send({"type": "stdin", "data": base64.b64encode(data).decode()})
            input_acknowledged.wait()
    except (BrokenPipeError, OSError):
        return


threading.Thread(target=forward_input, daemon=True).start()
for line in connection.makefile("rb"):
    message = json.loads(line)
    if message["type"] in ("stdout", "stderr"):
        output = sys.stdout.buffer if message["type"] == "stdout" else sys.stderr.buffer
        output.write(base64.b64decode(message["data"]))
        output.flush()
        send({"type": "output_ack", "channel": message["type"]})
    elif message["type"] == "stdin_ack":
        input_acknowledged.set()
    elif message["type"] == "stdin_closed":
        input_closed.set()
        input_acknowledged.set()
        try:
            os.close(sys.stdin.fileno())
        except OSError:
            pass
    elif message["type"] == "exit":
        connection.close()
        sys.exit(message["code"])
sys.stderr.write("Host command bridge disconnected before completion\n")
sys.exit(125)
