import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from typing import NamedTuple


class Terminal(NamedTuple):
    process: subprocess.Popen
    descriptor: int
    output: bytearray

root, quality, atelier, observer = sys.argv[1:]
event_log = os.path.join(root, "events.jsonl")
environment = dict(os.environ, PI_CODING_AGENT_DIR=os.path.join(root, "agent"),
                   QUALITY_LSP_SMOKE_LOG=event_log, PI_OFFLINE="1", TERM="xterm-256color")
terminals = []


def events():
    try:
        with open(event_log) as source:
            return [json.loads(line) for line in source if line.strip()]
    except FileNotFoundError:
        return []


def drain():
    for child, descriptor, output in terminals:
        while select.select([descriptor], [], [], 0)[0]:
            try:
                chunk = os.read(descriptor, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
            if b"\x1b[6n" in chunk:
                os.write(descriptor, b"\x1b[1;1R")


def wait_for(description, condition, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        drain()
        if condition():
            return
        time.sleep(0.05)
    raise RuntimeError("Timed out waiting for " + description)


def launch():
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 160, 0, 0))
    child = subprocess.Popen(["pi", "--offline", "--no-session", "--no-extensions", "--no-skills",
                              "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve",
                              "--tui-mode", "fullscreen", "-e", quality, "-e", atelier, "-e", observer],
                             cwd=os.path.join(root, "project"), env=environment,
                             stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    terminals.append(Terminal(child, master, bytearray()))
    return child, master


def shared_ready():
    return any(server.get("clients") == 2 and server.get("phase") == "ready"
               for event in events() for server in event.get("status", {}).get("lsp", []))


try:
    first, first_terminal = launch()
    wait_for("first Pi startup", lambda: any(event.get("kind") == "started" for event in events()))
    second, second_terminal = launch()
    wait_for("one shared ready language server", shared_ready)
    first.send_signal(signal.SIGTERM)
    wait_for("first Pi shutdown", lambda: first.poll() is not None)
    os.write(second_terminal, b"/quality lsp status\r")
    wait_for("remaining Pi still alive", lambda: second.poll() is None, 2)
    os.write(second_terminal, b"/reload\r")
    wait_for("reload lifecycle", lambda: any(event.get("kind") == "shutdown" and event.get("reason") == "reload" for event in events()))
    second.send_signal(signal.SIGTERM)
    wait_for("last Pi shutdown", lambda: second.poll() is not None)
    rendered = b"\n".join(bytes(terminal.output) for terminal in terminals).decode("utf-8", "replace")
    if "quality" not in rendered or "fixture" not in rendered:
        raise RuntimeError("Quality/LSP label was not rendered")
    print("TUI smoke passed: two Pi processes, shared ready LSP, status, reload, and shutdown")
finally:
    for index, (child, descriptor, output) in enumerate(terminals):
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
        with open(os.path.join(root, "terminal-" + str(index) + ".log"), "wb") as destination:
            destination.write(output)
        os.close(descriptor)
