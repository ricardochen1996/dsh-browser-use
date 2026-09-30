"""End-to-end check of the sidecar a DSH plugin talks to: one real browser, no model calls.

Run with ``uv run python test/check_bridge.py``. It starts the sidecar as a child process exactly
as the plugin does, drives the engine's local fixture page over the line-delimited JSON protocol, and
checks the outcome on the page itself rather than trusting the reported action.
"""

import json
import os
import subprocess
import sys
import tempfile
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


class Sidecar:
    """The bridge as a host process sees it: one JSON request per line, one answer per request."""

    def __init__(self, profile_dir):
        options = {
            "mode": "launch",
            "userDataDir": str(Path(profile_dir) / "browser"),
            "headless": True,
        }
        self.process = subprocess.Popen(
            [sys.executable, str(SIDECAR)],
            cwd=PACKAGE_ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.sequence = 0
        self.options = options

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

    def stop(self):
        try:
            self.send("shutdown")
        finally:
            self.process.wait(timeout=30)


def element(page, *, operation=None, contains=None):
    """The first offered element matching both filters; the model sees the same table."""
    for item in page["elements"]:
        if operation and operation not in item["operations"]:
            continue
        if contains and contains.lower() not in json.dumps(item, ensure_ascii=False).lower():
            continue
        return item
    raise AssertionError(f"No element offering {operation} matching {contains!r} in {page['elements']}")


def target(page, operation, element_index, option=None):
    """The offered target string for one element and operation."""
    for candidate in page["operations"][operation]:
        if candidate == element_index or candidate.startswith(f"{element_index}:"):
            if option is None or candidate.endswith(f":{option}"):
                return candidate
    raise AssertionError(f"{operation} offered no target for element {element_index}: {page['operations']}")


def main():
    passed = []
    with tempfile.TemporaryDirectory() as profile:
        sidecar = Sidecar(profile)
        try:
            greeting = sidecar.send("hello")
            assert greeting["protocol"] == 1, greeting
            assert {"open", "observe", "act", "screenshot", "diagnostics", "goal"} <= set(greeting["methods"])
            passed.append(f"sidecar speaks protocol 1 on Python {greeting['python']}")

            page = sidecar.send("open", url=FIXTURE)["page"]
            assert page["url"].endswith("fixture.html"), page["url"]
            assert "CLICK" in page["operations"] and "TYPE_TEXT" in page["operations"]
            passed.append(f"a launched browser observed {len(page['elements'])} elements")

            field = element(page, operation="TYPE_TEXT", contains="destination")
            sidecar.send("act", operation="TYPE_TEXT", target=target(page, "TYPE_TEXT", field["index"]),
                         text="Lisbon", fingerprint=page["fingerprint"])
            page = sidecar.send("observe")["page"]
            typed = element(page, operation="TYPE_TEXT", contains="destination")
            assert "Lisbon" in json.dumps(typed), typed
            passed.append("TYPE_TEXT entered the destination the observation offered")

            category = element(page, operation="SELECT", contains="category")
            design = next(option for option in category["options"] if "design" in option["label"].lower())
            page = sidecar.send("act", operation="SELECT", target=design["index"],
                                fingerprint=page["fingerprint"])["page"]
            passed.append("SELECT used an observed option target")

            submit = element(page, operation="CLICK", contains="find stays")
            page = sidecar.send("act", operation="CLICK", target=target(page, "CLICK", submit["index"]),
                                fingerprint=page["fingerprint"])["page"]
            assert "Casa Flora" in page["text"], page["text"][:400]
            passed.append("the submitted filters filtered the page to the one matching stay")

            stay = element(page, operation="CLICK", contains="view casa flora")
            page = sidecar.send("act", operation="CLICK", target=target(page, "CLICK", stay["index"]),
                                fingerprint=page["fingerprint"])["page"]
            # The outcome is read from the page, not from the fact that a click was accepted.
            assert "Destination Lisbon" in page["text"] and "Design" in page["text"], page["text"][:600]
            passed.append("the opened stay reports the typed destination and the chosen category")

            shot = sidecar.send("screenshot")
            assert len(shot["jpeg_base64"]) > 1000 and shot["width"] > 0, shot
            passed.append(f"screenshot returned {shot['width']}x{shot['height']}")

            report = sidecar.send("diagnostics")
            assert {"console", "exceptions", "failed_requests", "error_responses"} <= set(report)
            passed.append(f"diagnostics reported {len(report['console'])} console entries")

            stale = sidecar.process
            assert sidecar.send("close") == {"closed": True}
            passed.append("the owned tab was released")
            sidecar.stop()
            assert stale.poll() == 0
            passed.append("the sidecar exited cleanly and closed its browser")
        finally:
            if sidecar.process.poll() is None:
                sidecar.process.kill()
    print("\n".join(passed))
    print(f"PASS: {len(passed)} sidecar checks; no model calls")


if __name__ == "__main__":
    main()
