"""Runs glance.mjs inside a real pseudo-terminal and prints what reached it.

Used by test/terminal.test.mjs on macOS and Linux. The terminal side of the
pty stands in for the user's terminal window, so the bytes printed (hex) are
exactly what a terminal would receive.

    python3 pty_run.py <mode> <node> <glance.mjs> <event.json>

mode "direct": glance.mjs shares the pty as its controlling terminal, the way
a hook normally does, so it writes to /dev/tty.

mode "detached": glance.mjs runs in a new session with no controlling
terminal, under a parent that has the pty, so it has to find the device
through its ancestors (the ps fallback).
"""
import os
import pty
import select
import sys

mode, node, glance, event = sys.argv[1:5]

pid, fd = pty.fork()
if pid == 0:
    if mode == "detached":
        child = os.fork()
        if child != 0:
            # Stay alive, holding the pty, while the grandchild runs.
            _, status = os.waitpid(child, 0)
            os._exit(os.waitstatus_to_exitcode(status))
        os.setsid()
    stdin = os.open(event, os.O_RDONLY)
    os.dup2(stdin, 0)
    os.execv(node, [node, glance])

out = b""
while True:
    ready, _, _ = select.select([fd], [], [], 10)
    if not ready:
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        # Linux reports EIO once the last process holding the pty exits.
        break
    if not chunk:
        break
    out += chunk
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.hex())
sys.exit(os.waitstatus_to_exitcode(status))
