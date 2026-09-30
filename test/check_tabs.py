"""End-to-end check that a launch leaves one tab, against a real browser. No model calls.

Run with ``uv run python test/check_tabs.py``. A launch shows two tabs unless the browser's own
startup tab is closed once the driven tab is on its page, so this starts the sidecar the way the
plugin does, opens a page, and reads the browser's real page list over CDP. It checks the page list,
not the sidecar's own report: the tab count is what a person sees.

This is deliberately separate from ``tests/test_browser_tabs.py``, which stubs CDP offline. Only a
real launch can show that the connection layer really does open its own tab, and that the startup tab
is the one left over.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
# The sidecar ships with the plugin; the page it drives and the engine it imports come from the
# engine checkout (this package's path dependency, or whatever the environment points at).
SIDECAR = PACKAGE_ROOT / "sidecar" / "bridge.py"
ENGINE = Path(
    os.environ.get("DSH_BROWSER_USE_PROJECT")
    or os.environ.get("JEV_ULTRAFAST_PROJECT")
    or PACKAGE_ROOT.parent / "jev-ultrafast"
)
FIXTURE = (ENGINE / "jev_ultrafast" / "static" / "fixture.html").as_uri()
# A launched browser has to publish its DevTools endpoint before the sidecar answers.
BROWSER_BOOT_SECONDS = 25


def pages(port):
    """The browser's real page list: what a person would count in the tab strip."""
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3) as answer:
        return [t for t in json.load(answer) if t.get("type") == "page"]


def browser_port(profile):
    """The port from the launched browser's own command line, once it is up."""
    deadline = time.monotonic() + BROWSER_BOOT_SECONDS
    while time.monotonic() < deadline:
        listing = subprocess.run(["ps", "-Ao", "args="], capture_output=True, text=True).stdout
        for line in listing.splitlines():
            if str(profile) in line and "--type=" not in line:
                match = re.search(r"--remote-debugging-port=(\d+)", line)
                if match:
                    return int(match.group(1))
        time.sleep(0.05)
    raise AssertionError("the launched browser never appeared")


class Sidecar:
    """The bridge as the plugin drives it: one JSON request per line, one answer per request."""

    def __init__(self, profile):
        self.profile = Path(profile) / "browser"
        self.options = {"mode": "launch", "userDataDir": str(self.profile), "headless": True}
        self.sequence = 0
        self.process = subprocess.Popen(
            [sys.executable, str(SIDECAR)],
            cwd=PACKAGE_ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def send(self, method, **params):
        self.sequence += 1
        request = {"id": self.sequence, "method": method, "params": {**self.options, **params}}
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise AssertionError(f"The sidecar stopped answering: {self.process.stderr.read()[-2000:]}")
        answer = json.loads(line)
        assert answer.get("id") == self.sequence, answer
        if "error" in answer:
            raise AssertionError(f"{method} failed: {answer['error']}")
        return answer["result"]


def main():
    passed = []
    with tempfile.TemporaryDirectory() as profile:
        sidecar = Sidecar(profile)
        try:
            result = sidecar.send("open", url=FIXTURE)
            port = browser_port(sidecar.profile)
            time.sleep(0.5)  # let anything still settling finish before the tab strip is read
            shown = pages(port)

            assert result["page"]["url"].startswith("file://"), result["page"]["url"]
            passed.append(f"a launch drove the page it was asked for ({result['page']['title']})")

            assert len(shown) == 1, f"a launch left {len(shown)} tabs: {[t.get('url') for t in shown]}"
            passed.append("a launch left exactly one tab")

            assert shown[0]["url"].startswith("file://"), shown[0]
            passed.append("the tab on screen is the page, not a blank one")

            sidecar.send("open", url=f"{FIXTURE}?again=1")
            time.sleep(0.5)
            reopened = pages(port)
            assert len(reopened) == 1, f"reopening left {len(reopened)} tabs: {[t.get('url') for t in reopened]}"
            passed.append("opening a second page does not accumulate tabs")

            sidecar.send("shutdown")
            passed.append("the sidecar exited cleanly and closed its browser")
        finally:
            if sidecar.process.poll() is None:
                sidecar.process.kill()
    print("\n".join(passed))
    print(f"PASS: {len(passed)} tab checks; no model calls")


if __name__ == "__main__":
    main()
