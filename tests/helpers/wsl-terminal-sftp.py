"""Opt-in WSL validation against the production shell collector and OpenSSH.
Only the caller's disposable root-owned fixture is read or modified.
"""
import signal
import struct
import subprocess
import sys
import atexit
import contextlib
import pathlib
import shlex
import socket
import tempfile
import time

def deadline(_signal, _frame):
    raise TimeoutError("SFTP handshake did not finish")

signal.signal(signal.SIGALRM, deadline)
signal.alarm(20)
collector, bridge, directory = sys.argv[1:4]
resources = contextlib.ExitStack()
atexit.register(resources.close)
command = ["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "/bin/sh", "-c", collector, "_", bridge]
if sys.argv[4:] == ["--ssh"]:
    # Isolated loopback sshd: no changes to users, authorized_keys or system config.
    fixture = pathlib.Path(resources.enter_context(tempfile.TemporaryDirectory(prefix="shellpilot-sshd-test-")))
    for name in ["host", "client"]:
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(fixture / name)], check=True)
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    config = fixture / "sshd_config"
    config.write_text(f"Port {port}\nListenAddress 127.0.0.1\nHostKey {fixture}/host\nAuthorizedKeysFile {fixture}/client.pub\nPidFile {fixture}/pid\nPermitRootLogin yes\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nLogLevel ERROR\n")
    daemon = subprocess.Popen(["/usr/sbin/sshd", "-D", "-e", "-f", str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    def stop_daemon():
        daemon.terminate()
        daemon.wait(timeout=3)
    resources.callback(stop_daemon)
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                break
        except OSError:
            assert daemon.poll() is None, daemon.stderr.read().decode()
            time.sleep(0.02)
    command = ["ssh", "-T", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-i", str(fixture / "client"), "-p", str(port), "root@127.0.0.1", collector.replace('"$1"', shlex.quote(bridge))]
process = subprocess.Popen(
    command,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
)


def exact(length):
    result = b""
    while len(result) < length:
        chunk = process.stdout.read(length - len(result))
        if not chunk:
            raise AssertionError("SFTP channel unexpectedly closed")
        result += chunk
    return result


def receive():
    length = struct.unpack(">I", exact(4))[0]
    assert 0 < length < 262144
    return exact(length)


def send(data):
    process.stdin.write(struct.pack(">I", len(data)) + data)
    process.stdin.flush()


def string(value):
    value = value.encode() if isinstance(value, str) else value
    return struct.pack(">I", len(value)) + value


def unpack_string(data, offset):
    length = struct.unpack(">I", data[offset:offset + 4])[0]
    return data[offset + 4:offset + 4 + length], offset + 4 + length


request_id = 0


def request(kind, payload):
    global request_id
    request_id += 1
    send(bytes([kind]) + struct.pack(">I", request_id) + payload)
    response = receive()
    assert struct.unpack(">I", response[1:5])[0] == request_id
    return response


def success(response):
    assert response[0] == 101 and struct.unpack(">I", response[5:9])[0] == 0, response


try:
    assert process.stdout.readline() == b"SHELLPILOT_TERMINAL_SFTP_READY\n"
    send(b"\x01" + struct.pack(">I", 3))
    assert receive()[0] == 2

    response = request(16, string(directory))  # REALPATH
    assert response[0] == 104
    canonical, _ = unpack_string(response, 9)
    assert canonical.decode() == directory

    response = request(11, string(directory))  # OPENDIR
    assert response[0] == 102, response
    handle, _ = unpack_string(response, 5)
    response = request(12, string(handle))  # READDIR
    assert response[0] == 104 and b"private.txt" in response
    success(request(4, string(handle)))

    response = request(3, string(directory + "/private.txt") + struct.pack(">II", 1, 0))
    assert response[0] == 102, response
    handle, _ = unpack_string(response, 5)
    response = request(5, string(handle) + struct.pack(">QI", 0, 100))
    content, _ = unpack_string(response, 5)
    assert response[0] == 103 and content == b"root-only-test"
    success(request(4, string(handle)))

    response = request(3, string(directory + "/uploaded.txt") + struct.pack(">II", 2 | 8 | 16, 0))
    assert response[0] == 102, response
    handle, _ = unpack_string(response, 5)
    success(request(6, string(handle) + struct.pack(">Q", 0) + string(b"uploaded-through-root-channel")))
    success(request(4, string(handle)))
    assert open(directory + "/uploaded.txt", "rb").read() == b"uploaded-through-root-channel"
    success(request(13, string(directory + "/uploaded.txt")))
    print("WSL_TERMINAL_SFTP_OK")
finally:
    process.stdin.close()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=3)
