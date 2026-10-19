import base64
import json
import os
import socket
import subprocess
import sys
import threading
import queue

socket_path, shell_program = sys.argv[1:3]
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(socket_path)
os.chmod(socket_path, 0o600)
listener.listen()
MAX_MESSAGE_SIZE_BYTES = 1_048_576

connections = {}
outgoing_queues = {}
connections_lock = threading.Lock()
output_lock = threading.Lock()
next_connection_id = 0


def emit(message):
    with output_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def close_connection(connection):
    try:
        connection.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    connection.close()


def relay_connection(connection, connection_id, connection_closed):
    try:
        for line in connection.makefile("rb"):
            if len(line) > MAX_MESSAGE_SIZE_BYTES:
                break
            emit({"type": "bridge", "id": connection_id, "message": json.loads(line)})
    except (OSError, ValueError):
        pass
    finally:
        with connections_lock:
            connections.pop(connection_id, None)
            outgoing_queues.pop(connection_id, None)
        connection_closed.set()
        close_connection(connection)
        emit({"type": "disconnect", "id": connection_id})


def deliver_host_messages(connection, outgoing, connection_closed):
    while not connection_closed.is_set():
        try:
            encoded = outgoing.get(timeout=0.25)
        except queue.Empty:
            continue
        try:
            connection.sendall(encoded)
        except OSError:
            connection_closed.set()
            close_connection(connection)
            return


def accept_connections():
    global next_connection_id
    while True:
        try:
            connection, _ = listener.accept()
        except OSError:
            return
        with connections_lock:
            next_connection_id += 1
            connection_id = next_connection_id
            connections[connection_id] = connection
            outgoing = queue.Queue(maxsize=8)
            outgoing_queues[connection_id] = outgoing
        connection_closed = threading.Event()
        threading.Thread(target=deliver_host_messages, args=(connection, outgoing, connection_closed), daemon=True).start()
        threading.Thread(target=relay_connection, args=(connection, connection_id, connection_closed), daemon=True).start()


def receive_host_messages():
    for line in sys.stdin.buffer:
        message = json.loads(line)
        with connections_lock:
            connection = connections.get(message["id"])
            outgoing = outgoing_queues.get(message["id"])
        if connection is not None and outgoing is not None:
            encoded = (json.dumps(message["message"]) + "\n").encode()
            is_oversized_message = len(encoded) > MAX_MESSAGE_SIZE_BYTES
            if is_oversized_message:
                close_connection(connection)
                continue
            try:
                outgoing.put_nowait(encoded)
            except queue.Full:
                close_connection(connection)
    os._exit(125)


def forward_shell_output(stream, channel):
    while True:
        data = os.read(stream.fileno(), 65536)
        if not data:
            return
        emit({"type": "output", "channel": channel, "data": base64.b64encode(data).decode()})


threading.Thread(target=accept_connections, daemon=True).start()
threading.Thread(target=receive_host_messages, daemon=True).start()
shell = subprocess.Popen(["bash", "-c", shell_program], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
output_threads = [threading.Thread(target=forward_shell_output, args=(stream, channel)) for stream, channel in [(shell.stdout, "stdout"), (shell.stderr, "stderr")]]
for thread in output_threads:
    thread.start()
status = shell.wait()
for thread in output_threads:
    thread.join()
emit({"type": "shell_exit", "code": status if status >= 0 else 128 - status})
listener.close()
os.unlink(socket_path)
# Immediate exit avoids finalization blocking on the daemon stdin reader's buffered-I/O lock.
os._exit(0)
