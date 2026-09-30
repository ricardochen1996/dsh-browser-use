"""Line-delimited JSON sidecar: one browser session, observed targets, guarded execution.

The plugin's Node half speaks to this module over stdin/stdout; it is the Python side of
`dsh-browser-use`, and the engine (`jev_ultrafast`) is imported as a library:

    {"id": 1, "method": "open", "params": {"url": "https://example.com"}}
    {"id": 1, "result": {"page": {...}}}
    {"id": 2, "method": "act", "params": {"operation": "CLICK", "target": "2", "fingerprint": "..."}}
    {"id": 2, "error": {"kind": "stale", "message": "...", "page": {...}}}

    hello        protocol version, interpreter, engine versions, method list
    open         start a page in a browser this sidecar owns; answer with one observation
    observe      read the current page again
    act          one operation on one target of the named observation; refuses a page that moved
    screenshot   one JPEG of the visible viewport
    diagnostics  console entries, exceptions, failed and 4xx/5xx requests, drained per call
    goal         one TypeSafe run in its own tab; spends model quota
    close        release the owned tab
    shutdown     stop the tab, the browser, and the daemon

The bridge owns the observed page. A caller never sends a selector, a coordinate, or code: it sends
an operation and a target that the previous observation offered. Model output cannot become browser
input here any more than it can in the loop itself.

Requests are answered in order, so one long browser call delays the next request instead of running
beside it. A caller that no longer wants an answer stops waiting; the browser work already delivered
is never rolled back and never retried.

The launch behaviour a caller depends on lives beside this module: an endpoint is discovered over
HTTP (Chrome publishes no ``DevToolsActivePort`` for these profiles), a browser that already owns the
profile is adopted rather than duplicated, and a profile released moments ago is retried instead of
failing. Each has its own comment where it happens.
"""

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from collections import deque
from importlib import import_module
from pathlib import Path

# Browser Harness fixes its daemon name when its modules are imported, and one daemon owns one CDP
# connection. A sidecar therefore claims its own name (the host may choose one) before it connects,
# so two sidecars never share a daemon and the browser one sidecar launched.
os.environ.setdefault("BU_NAME", f"jev-sidecar-{os.getpid()}")

from browser_harness import _ipc, admin, helpers  # noqa: E402
from browser_harness.admin import restart_daemon  # noqa: E402
from browser_harness.helpers import drain_events  # noqa: E402
from jev_ultrafast.browser import Browser, LostSession, StalePage  # noqa: E402
from jev_ultrafast.model import action_space  # noqa: E402

PROTOCOL = 1
# Diagnostics are read from the daemon's event buffer; a page can emit thousands of network events.
MAX_CONSOLE = 40
MAX_EXCEPTIONS = 20
MAX_REQUESTS = 40
EVENT_TEXT = 600
# How long a launched browser has to publish its DevTools endpoint before the run fails.
BROWSER_BOOT_SECONDS = 25
DEFAULT_PROFILE = Path.home() / ".jev-ultrafast" / "browser"


class BridgeError(Exception):
    """A refused request. ``kind`` is the machine-readable half."""

    def __init__(self, kind, message, **extra):
        super().__init__(message)
        self.kind = kind
        self.extra = extra


def observation(page):
    """The whole model-visible state of one observation: no node ids, guards, or DOM references."""
    elements, targets, controls = action_space(page["actions"])
    operations = {operation: sorted(group) for operation, group in targets.items()}
    for name in controls:
        operations[name] = []
    return {
        "url": page["url"],
        "title": page.get("title", ""),
        "text": page.get("text", ""),
        "scroll": page.get("scroll"),
        "fingerprint": page["fingerprint"],
        "elements": elements,
        "operations": operations,
        "labels": {name: action["label"] for name, action in controls.items()},
    }


def resolve_action(page, operation, target):
    """The observed action a caller's operation/target pair names, or a refusal."""
    _, targets, controls = action_space(page["actions"])
    operation = (operation or "").upper()
    if operation in controls:
        if target not in (None, "", controls[operation]["id"]):
            raise BridgeError("unsupported_target", f"{operation} takes no target")
        return controls[operation]
    if operation not in targets:
        raise BridgeError(
            "unsupported_operation",
            f"{operation or 'operation'} is not offered on this page (offered: {', '.join(sorted(targets))})",
        )
    if target not in targets[operation]:
        raise BridgeError(
            "unsupported_target",
            f"target {target} is not offered for {operation} (offered: {', '.join(sorted(targets[operation]))})",
        )
    return targets[operation][target]


def sidecar_name():
    """Claim this sidecar's daemon name on the modules that read it while being imported.

    ``jev_ultrafast`` imports ``Browser`` on package import, which imports Browser Harness before this
    module runs. Rebinding the name here keeps the client and the daemon it starts on one name.
    """
    name = os.environ.get("BU_NAME") or f"jev-sidecar-{os.getpid()}"
    os.environ["BU_NAME"] = name
    for module in (admin, helpers):
        module.NAME = name
    helpers.SOCK = _ipc.sock_addr(name)
    return name


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def browser_executable(configured):
    """The browser to launch: the configured path, a PATH entry, or the macOS application."""
    candidates = [configured, shutil.which("google-chrome"), shutil.which("chromium"),
                  shutil.which("chrome"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)
    raise BridgeError("no_browser", "No Chrome or Chromium executable found; set executablePath.")


def devtools_endpoint(port, timeout=2.0):
    """The WebSocket endpoint a launched browser publishes, or None while it is still starting.

    The endpoint is read over HTTP rather than from the profile's ``DevToolsActivePort`` file: Chrome
    publishes that file for the profile it was started with, and a host process may not be allowed to
    read the profile the user browses with.
    """
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=timeout) as answer:
            return json.loads(answer.read().decode("utf-8")).get("webSocketDebuggerUrl")
    except (OSError, ValueError):
        return None


def clear_stale_singleton(data_dir):
    """Drop a profile lock whose owning browser is gone, so the next launch is not aborted.

    Chrome refuses to start when ``SingletonLock`` exists and names a live process; a lock left by a
    browser that has since exited only costs the next launch, and Chrome's own recovery does not run
    when the profile directory was reused by a different parent process.
    """
    lock = Path(data_dir) / "SingletonLock"
    try:
        target = str(os.readlink(lock))
        pid = int(target.rsplit("-", 1)[-1])
    except (OSError, ValueError):
        return
    try:
        os.kill(pid, 0)
        return  # the browser that took the lock is still running
    except ProcessLookupError:
        pass
    except PermissionError:
        return
    try:
        lock.unlink()
    except OSError:
        pass


def owner_pid(data_dir):
    """The live process holding this profile, or None."""
    try:
        pid = int(str(os.readlink(Path(data_dir) / "SingletonLock")).rsplit("-", 1)[-1])
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    return pid


def running_endpoint(data_dir):
    """The DevTools endpoint of a browser that already owns this profile, or None.

    Chrome answers a second launch on a claimed profile by handing the request to the running
    instance and exiting with status 0, so a launcher that only watches its own child sees a clean
    exit and no endpoint. The running instance is still usable: its port is on its command line.
    """
    pid = owner_pid(data_dir)
    if pid is None:
        return None
    try:
        listing = subprocess.run(
            ["ps", "-p", str(pid), "-o", "args="], capture_output=True, text=True, timeout=5
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"--remote-debugging-port=(\d+)", listing or "")
    if match is None:
        return None
    return devtools_endpoint(int(match.group(1)))


class AdoptedBrowser:
    """A browser an earlier sidecar started for this same profile, kept for the same lifecycle.

    Its owning process is not this process's child, so it is stopped by signal rather than by
    ``Popen``.
    """

    def __init__(self, pid):
        self.pid = pid

    def poll(self):
        try:
            os.kill(self.pid, 0)
            return None
        except OSError:
            return 0

    def terminate(self):
        try:
            os.kill(self.pid, signal.SIGTERM)
        except OSError:
            pass

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
        except OSError:
            pass

    def wait(self, timeout=None):
        deadline = time.monotonic() + (timeout or 0)
        while time.monotonic() < deadline:
            if self.poll() is not None:
                return 0
            time.sleep(0.1)
        raise TimeoutError("the adopted browser did not stop")


def start_browser(command, port, data_dir):
    """Start one browser process and wait for the DevTools endpoint it publishes."""
    clear_stale_singleton(data_dir)
    process = subprocess.Popen(
        command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True
    )
    deadline = time.monotonic() + BROWSER_BOOT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return None, process
        endpoint = devtools_endpoint(port)
        if endpoint:
            return endpoint, process
        time.sleep(0.2)
    process.terminate()
    return None, process


def launch_browser(executable, user_data_dir, port, headless):
    """Start a dedicated browser and return the environment that points Browser Harness at it.

    The browser the user browses with stays out of reach: a host process cannot read that profile
    directory, and Chrome only offers its DevTools endpoint there. A browser started here has its own
    profile directory and its own port, so nothing has to be read out of reach.

    A browser that was just closed may still be releasing the profile, which makes Chrome exit at once
    (status 21). Starting again a moment later is what a person does by hand, so it is what this does.
    A browser that still owns the profile is adopted instead of duplicated: it is the same run's
    browser, left behind by a host that restarted.
    """
    data_dir = Path(user_data_dir).expanduser()
    data_dir.mkdir(parents=True, exist_ok=True)
    adopted = running_endpoint(data_dir)
    if adopted:
        restart_daemon()  # the daemon from the earlier sidecar still holds this browser
        return {"BU_CDP_WS": adopted, "_process": AdoptedBrowser(owner_pid(data_dir))}
    command = [
        browser_executable(executable),
        f"--remote-debugging-port={port}",
        f"--user-data-dir={data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=DialMediaRouteProvider",
    ]
    if headless:
        command.append("--headless=new")
    command.append("about:blank")
    process = None
    for attempt in range(3):
        endpoint, process = start_browser(command, port, data_dir)
        if endpoint is not None:
            return {"BU_CDP_WS": endpoint, "_process": process}
        if process.poll() is None:
            break
        time.sleep(1.0 + attempt)
    if process is not None and process.poll() == 0:
        # A clean immediate exit is Chrome handing the launch to the instance that already owns the
        # profile. Saying so is more useful than an exit status nobody can act on.
        raise BridgeError(
            "browser_in_use",
            f"Another browser already owns {data_dir}: Chrome handed the launch to it and exited. "
            "Close that browser, or give this run its own profile directory.",
        )
    detail = f" (exit status {process.poll()})" if process is not None and process.poll() is not None \
        else f" within {BROWSER_BOOT_SECONDS}s"
    raise BridgeError("no_browser", f"The browser did not open a DevTools endpoint{detail}.")


def console_events(events, session):
    """Console output, exceptions, and request failures for one session, newest last."""
    console = deque(maxlen=MAX_CONSOLE)
    exceptions = deque(maxlen=MAX_EXCEPTIONS)
    failed = deque(maxlen=MAX_REQUESTS)
    error_responses = deque(maxlen=MAX_REQUESTS)
    names = {}
    for event in events:
        if event.get("session_id") != session:
            continue
        method, params = event.get("method"), event.get("params") or {}
        if method == "Runtime.consoleAPICalled":
            text = " ".join(str(arg.get("value", arg.get("description", ""))) for arg in params.get("args") or [])
            console.append({"level": params.get("type", "log"), "text": text[:EVENT_TEXT]})
        elif method == "Runtime.exceptionThrown":
            details = params.get("exceptionDetails") or {}
            exception = details.get("exception") or {}
            console.append({"level": "exception",
                            "text": str(exception.get("description") or details.get("text") or "")[:EVENT_TEXT]})
            exceptions.append({"text": str(details.get("text") or "")[:EVENT_TEXT], "line": details.get("lineNumber")})
        elif method == "Network.requestWillBeSent":
            names[params.get("requestId")] = (params.get("request") or {}).get("url", "")
        elif method == "Network.loadingFailed":
            failed.append({"url": names.get(params.get("requestId"), "")[:EVENT_TEXT],
                           "error": params.get("errorText", ""), "canceled": bool(params.get("canceled"))})
        elif method == "Network.responseReceived":
            response = params.get("response") or {}
            if (response.get("status") or 0) >= 400:
                error_responses.append({"status": response["status"], "url": response.get("url", "")[:EVENT_TEXT]})
    return {"console": list(console), "exceptions": list(exceptions),
            "failed_requests": list(failed), "error_responses": list(error_responses)}


def request_environment():
    """Credentials for goal mode stay out of the plugin config; the project's .env is enough."""
    engine = Path(import_module("jev_ultrafast").__file__).resolve().parent.parent
    path = engine / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


class Session:
    """One owned browser tab and the observation a caller's next action must refer to."""

    def __init__(self, open_browser=Browser, launch=launch_browser):
        self.browser = None
        self.page = None
        self.owned_browser = None
        self._open_browser = open_browser
        self._launch = launch

    def _connect(self, params):
        """Point Browser Harness at a browser before anything connects to one."""
        sidecar_name()
        endpoint = params.get("cdpEndpoint") or os.environ.get("BU_CDP_WS")
        if endpoint:
            os.environ["BU_CDP_WS"] = endpoint
            return
        if params.get("mode", "launch") != "launch":
            raise BridgeError("no_browser", "mode 'attach' requires a cdpEndpoint")
        if self.owned_browser is not None:
            return
        env = self._launch(params.get("executablePath"), params.get("userDataDir") or DEFAULT_PROFILE,
                           params.get("port") or free_port(), bool(params.get("headless")))
        self.owned_browser = env.pop("_process")
        os.environ.update(env)

    def open(self, params):
        url = (params.get("url") or "").strip()
        if not url:
            raise BridgeError("bad_request", "open needs a url")
        self.close()
        self._connect(params)
        self.browser = self._open_browser(url, reuse=bool(params.get("reuse")))
        try:
            self.page = self.browser.observe(screenshot=False)
        except Exception:
            self.browser.close()
            self.browser = None
            raise
        return {"page": observation(self.page)}

    def observe(self, params):
        if self.browser is None:
            raise BridgeError("no_session", "Open a page first.")
        self.page = self.browser.observe(screenshot=False)
        return {"page": observation(self.page)}

    def act(self, params):
        if self.browser is None or self.page is None:
            raise BridgeError("no_session", "Open a page first.")
        action = resolve_action(self.page, params.get("operation"), params.get("target"))
        if not params.get("fingerprint"):
            raise BridgeError("bad_request", "act needs the fingerprint of the observation it refers to")
        if params["fingerprint"] != self.page["fingerprint"]:
            raise BridgeError("stale", "The page changed since that observation. Choose from the new one.",
                              page=observation(self.page))
        text = params.get("text")
        if action["kind"] == "fill" and not (isinstance(text, str) and text):
            raise BridgeError("bad_request", "TYPE_TEXT needs the text to enter")
        try:
            executed = self.browser.act(action, self.page, text=text)
        except StalePage as error:
            # Nothing ran against the page: report the fresh observation instead of retrying.
            self.page = self.browser.observe(screenshot=False)
            raise BridgeError("stale", str(error), page=observation(self.page)) from None
        except LostSession as error:
            self.browser, self.page = None, None
            raise BridgeError("lost_session", str(error)) from None
        self.browser.settle(action["kind"])
        self.page = self.browser.observe(screenshot=False)
        return {
            "executed": {**executed, "operation": params.get("operation"), "target": params.get("target"),
                         "label": action["label"]},
            "page": observation(self.page),
        }

    def screenshot(self, params):
        if self.browser is None:
            raise BridgeError("no_session", "Open a page first.")
        shot = self.browser.call("Page.captureScreenshot", format="jpeg", quality=params.get("quality", 72))
        size = self.browser.evaluate("[innerWidth,innerHeight]") or [0, 0]
        return {"jpeg_base64": shot["data"], "width": size[0], "height": size[1]}

    def diagnostics(self, params):
        if self.browser is None:
            raise BridgeError("no_session", "Open a page first.")
        report = console_events(drain_events(), self.browser.session)
        report["url"] = self.page["url"] if self.page else ""
        return report

    def goal(self, params):
        """Run the TypeSafe policy once, in its own tab. Spends model quota; never a retry."""
        from jev_ultrafast.agent import Agent
        from jev_ultrafast.model import NoTextValue

        url, goal = (params.get("url") or "").strip(), (params.get("goal") or "").strip()
        if not url or not goal:
            raise BridgeError("bad_request", "goal needs a url and a goal")
        request_environment()
        self._connect(params)
        last = None
        try:
            with Agent(url, goal, screenshots=False) as agent:
                for state in agent.run():
                    last = state
        except NoTextValue as error:
            raise BridgeError("no_text", str(error)) from None
        except (StalePage, LostSession) as error:
            raise BridgeError("browser_error", str(error)) from None
        if last is None:
            raise BridgeError("browser_error", "The run produced no state")
        history = [
            {
                "step": item["step"],
                "operation": item.get("operation"),
                "action": item.get("action"),
                "text": item.get("text"),
                "page_changed": item.get("page_changed"),
                "url": item.get("url"),
            }
            for item in last["history"]
        ]
        return {
            "status": last["status"],
            "elapsed_ms": last["elapsed_ms"],
            "steps": len(history),
            "history": history,
            "text_calls": [{"field": call.get("field"), "value": call.get("value")} for call in last["text_calls"]],
        }

    def close(self, params=None):
        """Close the owned tab. The launched browser stays up for the next page."""
        if self.browser is not None:
            try:
                self.browser.close()
            except Exception:
                pass  # a lost tab or session is already closed as far as this sidecar is concerned
        self.browser, self.page = None, None
        return {"closed": True}

    def shutdown(self, params):
        """Release the tab, close the owned browser, and stop the daemon that owned the connection."""
        self.close({})
        if self.owned_browser is not None:
            # Wait for the process to leave before anything launches on this profile again.
            self.owned_browser.terminate()
            try:
                self.owned_browser.wait(timeout=10)
            except Exception:
                self.owned_browser.kill()
            self.owned_browser = None
        try:
            restart_daemon()  # a stopped daemon is the half that stops holding the CDP connection
        except Exception:
            pass  # an already-stopped daemon needs nothing here
        return {"bye": True}


METHODS = ("hello", "open", "observe", "act", "screenshot", "diagnostics", "goal", "close", "shutdown")


def hello():
    """Report the interpreter this sidecar actually runs, so a host can fail fast and readably."""
    import browser_harness

    return {
        "protocol": PROTOCOL,
        "python": sys.version.split()[0],
        "browser_harness": getattr(browser_harness, "__version__", "unknown"),
        "cwd": str(Path.cwd()),
        "methods": list(METHODS),
    }


def dispatch(session, request):
    """One request in, one response out. Every failure is a value, never a traceback on stdout."""
    method = request.get("method")
    if method not in METHODS:
        return {"kind": "unknown_method", "message": f"Unknown method {method!r}"}
    try:
        result = hello() if method == "hello" else getattr(session, method)(request.get("params") or {})
        return {"result": result, "shutdown": method == "shutdown"}
    except BridgeError as error:
        return {"kind": error.kind, "message": str(error), **error.extra}
    except (ValueError, RuntimeError, OSError) as error:
        return {"kind": "browser_error", "message": f"{type(error).__name__}: {error}"}


def serve(instream=None, outstream=None):
    """Read requests from stdin and answer on stdout until shutdown or end of input."""
    instream = instream or sys.stdin
    outstream = outstream or sys.stdout
    session = Session()

    def write(payload):
        outstream.write(json.dumps(payload, ensure_ascii=False) + "\n")
        outstream.flush()

    for line in instream:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("a request must be a JSON object")
        except ValueError as error:
            write({"id": None, "error": {"kind": "bad_request", "message": f"Unreadable request: {error}"}})
            continue
        response = dispatch(session, request)
        if "result" in response:
            write({"id": request.get("id"), "result": response["result"]})
        else:
            write({"id": request.get("id"), "error": response})
        if response.get("shutdown"):
            break
    session.close({})


def main():
    serve()


if __name__ == "__main__":
    main()
