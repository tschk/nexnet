import os
import pty
import select
import signal
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(__file__))
from vt import Screen

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
TERM_BIN = os.environ.get("NEXNET_BIN", os.path.join(ROOT, "terminal", "target", "release", "nexnet"))
PORT = os.environ.get("E2E_PORT", "8799")
URL = f"http://127.0.0.1:{PORT}"
failures = []


def check(name, cond, screen=None):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)
        if screen is not None:
            print(screen.text())


class Tui:
    def __init__(self, wallet, env_extra=None):
        env = dict(os.environ, NEXNET_WALLET=wallet, NEXNET_GATEWAY_URL=URL, TERM="xterm-256color", NEXNET_COLORS="rgb")
        env.pop("SSH_AUTH_SOCK", None)
        env.update(env_extra or {})
        self.screen = Screen()
        pid, fd = pty.fork()
        if pid == 0:
            os.environ.update(env)
            os.execv(TERM_BIN, [TERM_BIN, "--agent", "bun", os.path.join(ROOT, "packages/agent/src/main.ts"), "serve"])
        self.pid, self.fd = pid, fd
        import fcntl, struct, termios
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        self.pump(1.5)

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                self.screen.feed(data)

    def keys(self, text, wait=0.6):
        os.write(self.fd, text.encode())
        self.pump(wait)

    def wait_for(self, needle, seconds=6):
        end = time.time() + seconds
        while time.time() < end:
            if needle in self.screen.text():
                return True
            self.pump(0.2)
        return needle in self.screen.text()

    def close(self):
        try:
            os.kill(self.pid, signal.SIGTERM)
            os.waitpid(self.pid, 0)
        except OSError:
            pass


def main():
    work = tempfile.mkdtemp(prefix="nexnet-e2e-")
    owner_wallet = os.path.join(work, "owner.json")
    visitor_wallet = os.path.join(work, "visitor.json")
    owner_id = subprocess.check_output(
        ["bun", "-e", f"import {{FileWalletStore}} from '{ROOT}/packages/agent/src/node-platform.ts';"
         f"import {{identityIdFromWallet,toHex}} from '{ROOT}/packages/protocol/src/index.ts';"
         f"const w=await new FileWalletStore('{owner_wallet}').create();console.log(toHex(identityIdFromWallet(w.publicKey)))"]
    ).decode().strip()
    gateway = subprocess.Popen(
        ["bun", os.path.join(ROOT, "packages/gateway/src/main.ts")],
        env=dict(os.environ, NEXNET_MODE="dev-chain", NEXNET_AUDIENCE="nexnet:e2e", NEXNET_OWNER_IDENTITY=owner_id,
                 NEXNET_STATE_DIR=os.path.join(work, "state"), PORT=PORT),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    visitor = owner = None
    try:
        visitor = Tui(visitor_wallet)
        visitor.keys("2")
        check("visitor sees the public chat page", visitor.wait_for("public"), visitor.screen)
        visitor.keys("e")
        visitor.keys("hello before signing in")
        visitor.keys("\r")
        check("posting signed out points at Identity and keeps the draft",
              "hello before signing in" in visitor.screen.text() and ("Identity" in visitor.screen.text() or "sign in" in visitor.screen.text().lower()),
              visitor.screen)
        visitor.keys("\x1b")
        visitor.keys("3")
        visitor.keys("c", 2)
        check("identity created", "nx1" in visitor.screen.text(), visitor.screen)
        visitor.keys("\r", 2)
        check("signed in with wallet", "wallet" in visitor.screen.text().lower(), visitor.screen)
        visitor.keys("2")
        visitor.keys("e")
        visitor.keys("\r", 2)
        check("draft survived and posted", visitor.wait_for("hello before signing in"), visitor.screen)
        visitor.keys("\x1b")

        owner = Tui(owner_wallet)
        owner.keys("3")
        owner.keys("\r", 3)
        owner.keys("1")
        owner.keys("e")
        owner.keys("shipping the first update")
        owner.keys("\r", 2)
        owner.keys("\x1b")
        check("owner posts to updates", owner.wait_for("shipping the first update"), owner.screen)
        visitor.keys("1", 1)
        check("visitor receives the update live", visitor.wait_for("shipping the first update"), visitor.screen)
        visitor.keys("e", 1)
        check("visitor cannot edit updates", "shipping the first update" in visitor.screen.text() and "editing" not in visitor.screen.text().lower(), visitor.screen)
        visitor.keys("q", 1)
    finally:
        for t in (visitor, owner):
            if t:
                t.close()
        gateway.terminate()
    if failures:
        print("FAILURES:", failures)
        sys.exit(1)
    print("ALL E2E CHECKS PASSED")


main()
