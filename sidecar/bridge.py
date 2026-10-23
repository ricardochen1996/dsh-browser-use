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
    evaluate     one JavaScript expression in the owned page, answered as text; no observation
    act          one operation on one target of the named observation; refuses a page that moved.
                 With an ``intent`` and no operation, the policy chooses the operation and target —
                 TypeSafe, or the text model itself with ``jev.decider: chat``; a TYPE_TEXT without
                 text gets its value from the text model either way
    screenshot   one JPEG of the visible viewport
    diagnostics  console entries, exceptions, failed and 4xx/5xx requests, drained per call
    goal         one policy run in its own tab; spends model quota
    close        release the owned tab
    shutdown     stop the tab, the browser, and the daemon

The bridge owns the observed page. For every guarded operation a caller never sends a selector, a
coordinate, or code: it sends an operation and a target that the previous observation offered, so
model output cannot become browser input here any more than it can in the loop itself.

``evaluate`` is the one method that takes code, and it is deliberately the exception: a model that
needs a programmatic read or a one-off DOM operation must get it over this session's single CDP
connection. The alternative is a second client (a raw websocket, another harness daemon), which
Chrome 144+ answers with its own "Allow remote debugging?" prompt per connection and which leaves
the page driven by two loops. It produces no observation: the next guard still belongs to the
observation the page was last read in.

Requests are answered in order, so one long browser call delays the next request instead of running
beside it. A caller that no longer wants an answer stops waiting; the browser work already delivered
is never rolled back and never retried.

The launch behaviour a caller depends on lives beside this module: an endpoint is discovered over
HTTP (Chrome publishes no ``DevToolsActivePort`` for these profiles), a browser that already owns the
profile is adopted rather than duplicated, and a profile released moments ago is retried instead of
failing. Each has its own comment where it happens. Attach mode without an endpoint drives the browser
you already use: it only checks that one publishes remote debugging, then lets Browser Harness find it.
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
from contextlib import contextmanager, nullcontext, redirect_stdout
from pathlib import Path

# Browser Harness fixes its daemon name when its modules are imported, and one daemon owns one CDP
# connection. A sidecar therefore claims its own name (the host may choose one) before it connects,
# so two sidecars never share a daemon and the browser one sidecar launched.
os.environ.setdefault("BU_NAME", f"jev-sidecar-{os.getpid()}")

from browser_harness import _ipc, admin, helpers  # noqa: E402
from browser_harness.admin import restart_daemon  # noqa: E402
from browser_harness.helpers import drain_events  # noqa: E402
from jev_ultrafast.browser import Browser, LostSession, StalePage  # noqa: E402
from jev_ultrafast.model import NoTextValue, action_space, choose, field_context, field_text  # noqa: E402

PROTOCOL = 1
# Diagnostics are read from the daemon's event buffer; a page can emit thousands of network events.
MAX_CONSOLE = 40
MAX_EXCEPTIONS = 20
MAX_REQUESTS = 40
EVENT_TEXT = 600
# One evaluated expression's answer is page data, not a page: cap it so a JSON dump cannot crowd out
# the conversation. A string comes back as itself; every other value as JSON.
MAX_EVAL_TEXT = 12000
EVAL_EXCEPTION_TEXT = 2000
# An expression that awaits a promise must not hold the sidecar (and the request behind it) forever.
EVAL_TIMEOUT_MS = 30000
EVAL_TIMEOUT_MAX_MS = 120000
# How long a launched browser has to publish its DevTools endpoint before the run fails.
BROWSER_BOOT_SECONDS = 25
# How much of what the browser printed a failed launch quotes back: its own explanation, not a log.
BROWSER_OUTPUT_LINES = 12
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

    This asks a port on this machine, so the request is made without a proxy. A system or environment
    proxy that does not exclude 127.0.0.1 answers for a browser listening perfectly well, and the
    answer is indistinguishable from a browser that never started: a healthy launch then fails as a
    timeout. ``discover_local_browser`` reaches its endpoint over a raw socket for the same reason.
    """
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/json/version", timeout=timeout) as answer:
            return json.loads(answer.read().decode("utf-8")).get("webSocketDebuggerUrl")
    except (OSError, ValueError):
        return None


def discover_local_browser(profiles=None):
    """The profile directory of the running browser you opened remote debugging on.

    ``chrome://inspect/#remote-debugging`` makes a browser publish ``DevToolsActivePort`` in the
    profile it browses with. Browser Harness finds that browser the same way when no endpoint is
    configured, and only that path waits for Chrome's "Allow remote debugging?" prompt instead of
    timing out on it, so this only checks what it will find and says what is missing when it would
    find nothing. macOS refuses the read unless the app running DSH has Full Disk Access.
    """
    if profiles is None:
        from browser_harness.daemon import profile_dirs

        profiles = profile_dirs()
    denied = []
    for base in profiles:
        path = Path(base) / "DevToolsActivePort"
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except PermissionError:
            denied.append(path)
            continue
        except OSError:
            continue
        port = lines[0].strip() if lines else ""
        if not port.isdigit():
            continue
        try:
            socket.create_connection(("127.0.0.1", int(port)), timeout=0.5).close()
        except OSError:
            continue  # a browser that has since quit leaves this file behind
        return Path(base)
    if denied:
        raise BridgeError(
            "no_permission",
            f"This process may not read {denied[0]}, so it cannot find your running browser. Give the app "
            "that runs DSH Full Disk Access (System Settings > Privacy & Security > Full Disk Access), "
            "then quit and reopen DSH.",
        )
    raise BridgeError(
        "no_browser",
        "No running browser has remote debugging turned on. Open chrome://inspect/#remote-debugging in "
        "the Chrome you use and allow remote debugging, or set cdpEndpoint.",
    )


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


def start_browser(command, port, data_dir, output=None):
    """Start one browser process and wait for the DevTools endpoint it publishes.

    ``output`` is the file the browser's own stdout and stderr are written to. That stream is where a
    browser that runs but never publishes its endpoint explains itself — a port it could not take, a
    sandbox it could not enter, a policy that forbids remote debugging — and nothing else records it.
    """
    clear_stale_singleton(data_dir)
    log = open(output, "ab") if output else None
    try:
        process = subprocess.Popen(
            command, stdout=log or subprocess.DEVNULL, stderr=log or subprocess.DEVNULL,
            start_new_session=True,
        )
    finally:
        if log is not None:
            log.close()  # the child holds its own descriptor; this one only opened the file
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


def browser_output_path(data_dir):
    """Where one launch records the browser's own output: beside the profile it was given."""
    return Path(data_dir) / "browser-output.log"


def recorded_devtools_port(data_dir):
    """The port the browser recorded for its DevTools endpoint, or None when it never got that far."""
    try:
        lines = browser_output_path(data_dir).with_name("DevToolsActivePort").read_text(
            encoding="utf-8", errors="replace"
        ).splitlines()
    except OSError:
        return None
    first = lines[0].strip() if lines else ""
    return int(first) if first.isdigit() else None


def browser_said(output, limit=BROWSER_OUTPUT_LINES):
    """The last lines the browser printed, which is where a refused launch states why."""
    try:
        lines = Path(output).read_text(encoding="utf-8", errors="replace").splitlines()
    except (OSError, TypeError):
        return []
    return [line.strip() for line in lines if line.strip()][-limit:]


def launch_diagnosis(command, data_dir, port, output):
    """What a failed launch left behind, in the words a person needs to act on it.

    A plain "did not open a DevTools endpoint" is true and useless: it reads the same whether the
    browser exited, refused the port, was blocked by a proxy on the probe, or never enabled remote
    debugging. The command, the profile and the browser's own output tell those apart.
    """
    lines = [f"\n  launched {command[0]} on {data_dir} for port {port}"]
    recorded = recorded_devtools_port(data_dir)
    if recorded is None:
        lines.append("  the profile records no DevTools port: the browser never enabled remote debugging")
    elif recorded != port:
        lines.append(f"  the profile records DevTools on port {recorded}, not {port}: the browser is up and "
                     "listening elsewhere")
    else:
        lines.append(f"  the profile records DevTools on port {port}, the port this probe asked: the browser "
                     "was up and the probe could not reach it")
    said = browser_said(output)
    if said:
        lines.append("  the browser said: " + " | ".join(said))
    elif output is not None:
        lines.append(f"  the browser printed nothing (see {output})")
    return "\n".join(lines)


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
    output = browser_output_path(data_dir)
    try:
        output.write_bytes(b"")  # this launch's evidence only, not the previous session's
    except OSError:
        output = None  # a profile the browser can use but this process cannot write beside
    process = None
    for attempt in range(3):
        endpoint, process = start_browser(command, port, data_dir, output)
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
    raise BridgeError(
        "no_browser",
        f"The browser did not open a DevTools endpoint{detail}.{launch_diagnosis(command, data_dir, port, output)}",
    )


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


ENGINE_VARIABLES = (
    "JEV_DECIDER",
    "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_MODEL", "TYPESAFE_FALLBACK_URL",
    "TEXT_MODEL_API_KEY", "TEXT_MODEL_BASE_URL", "TEXT_MODEL", "TEXT_MODEL_REASONING", "TEXT_MODEL_HEADERS",
)


def decisions(values):
    """Who answers the loop's questions: ``chat`` the text model, anything else the TypeSafe endpoint."""
    return "chat" if str(values.get("JEV_DECIDER") or "").strip() == "chat" else "typesafe"


def chat_decisions_endpoint():
    """Serve the engine's chat-model endpoint on loopback for one call, and aim the loop at it.

    ``jev.decider: chat`` has the text model choose the operation and the target. The engine's
    ``llm_endpoint`` answers the very System One request the loop would otherwise post to TypeSafe, so
    the loop cannot tell the two apart and nothing else in this sidecar changes. Imported here, not at
    module load: an engine older than the endpoint should fail one call, never the whole sidecar.
    """
    from jev_ultrafast.llm_endpoint import Endpoint, chooser_from_env, serve_in_thread

    # chooser_from_env reads the text model's variables, which engine_environment has just set.
    chooser, page_chars = chooser_from_env()
    server, url = serve_in_thread(Endpoint(chooser, page_chars))
    os.environ["TYPESAFE_BASE_URL"] = url
    os.environ["TYPESAFE_MODEL"] = chooser.model
    return server


@contextmanager
def engine_environment(values, endpoint=False):
    """The engine's model variables for one model call, exactly as the plugin sent them, then none.

    ``endpoint`` also starts the chat-model decision endpoint, which only a call that needs a *decision*
    does — an intent, or a goal run. A TYPE_TEXT value needs the text model and nothing to decide from.
    """
    for name in ENGINE_VARIABLES:
        os.environ.pop(name, None)
    os.environ.update({name: str(values[name]) for name in ENGINE_VARIABLES if values.get(name)})
    # That endpoint logs every request to stdout ("[llm-endpoint] ...", and the same on a refused
    # request), and this process's stdout carries the line-delimited JSON the host reads. While one is
    # served, prints belong on stderr instead — which the host keeps as diagnostics. Protocol answers
    # are unaffected: `serve` writes to the stream it captured at startup, not to `sys.stdout`.
    chat = endpoint and decisions(values) == "chat"
    printed = redirect_stdout(sys.stderr) if chat else nullcontext()
    server = None
    with printed:
        try:
            if chat:
                server = chat_decisions_endpoint()
            yield
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            for name in ENGINE_VARIABLES:
                os.environ.pop(name, None)


def evaluate_timeout(value):
    """How long an awaitPromise expression may run, in the CDP's own milliseconds, clamped."""
    try:
        timeout = int(value)
    except (TypeError, ValueError):
        return EVAL_TIMEOUT_MS
    return max(1000, min(timeout, EVAL_TIMEOUT_MAX_MS))


def stdio_safe(text):
    """Text this line-delimited JSON protocol can actually write: a lone surrogate would end the sidecar.

    An expression is the one input that can hand back a string no DOM ever holds, so the answer is
    made encodable here rather than failing on the request that carries it.
    """
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return text.encode("utf-8", "replace").decode("utf-8")
    return text


def evaluated(result):
    """One ``Runtime.evaluate`` result as the text a model reads: the string itself, else JSON.

    ``returnByValue`` cannot carry a DOM node, a function, or a Promise; Chrome sends a description
    instead, and that description is the only useful answer there is.
    """
    if result.get("unserializableValue") is not None:
        return stdio_safe(str(result["unserializableValue"]))  # NaN, Infinity, -0, 10n
    if "value" in result:
        value = result["value"]
        if isinstance(value, str):
            return stdio_safe(value)
        try:
            return stdio_safe(json.dumps(value, ensure_ascii=False))
        except (TypeError, ValueError):
            return stdio_safe(str(value))
    return stdio_safe(str(result.get("description") or result.get("type") or "undefined"))


def exception_text(details):
    """What a thrown expression says — its description, or where it threw when there is none."""
    exception = details.get("exception") or {}
    text = str(exception.get("description") or details.get("text") or "").strip()
    if not text:
        text = "the expression threw"
        if details.get("lineNumber") is not None:
            text += f" at line {details['lineNumber']}, column {details.get('columnNumber')}"
    return stdio_safe(text[:EVAL_EXCEPTION_TEXT])


class Session:
    """One owned browser tab and the observation a caller's next action must refer to."""

    def __init__(self, open_browser=Browser, launch=launch_browser):
        self.browser = None
        self.page = None
        # What ran on this tab, in the engine's history shape: Jev reads it to avoid repeating a no-op.
        self.history = []
        self.owned_browser = None
        self._open_browser = open_browser
        self._launch = launch

    def _connect(self, params):
        """Point Browser Harness at a browser before anything connects to one."""
        sidecar_name()
        endpoint = (params.get("cdpEndpoint") or "").strip()
        if not endpoint and params.get("mode") == "attach":
            # No endpoint names the browser you are already using: Browser Harness discovers it,
            # which it only does while no endpoint is set.
            discover_local_browser()
            os.environ.pop("BU_CDP_WS", None)
            os.environ.pop("BU_CDP_URL", None)
            return
        endpoint = endpoint or (os.environ.get("BU_CDP_WS") or "").strip()
        if endpoint:
            # Browser Harness takes a ws URL verbatim but resolves an HTTP one through /json/version,
            # and only the HTTP form survives a browser restart: Chrome puts a fresh id in the ws URL
            # every time it starts. Accept both, the way the MCP providers accept either.
            if any(character.isspace() for character in endpoint):
                raise BridgeError("bad_request", "cdpEndpoint must not contain whitespace")
            if endpoint.startswith(("http://", "https://")):
                os.environ.pop("BU_CDP_WS", None)
                os.environ["BU_CDP_URL"] = endpoint
            elif endpoint.startswith(("ws://", "wss://")):
                os.environ.pop("BU_CDP_URL", None)
                os.environ["BU_CDP_WS"] = endpoint
            else:
                raise BridgeError("bad_request", "cdpEndpoint must be an http(s) or ws(s) URL")
            return
        if params.get("mode", "launch") != "launch":
            raise BridgeError("bad_request", f"unknown mode {params.get('mode')!r}: use 'launch' or 'attach'")
        if self.owned_browser is not None:
            return
        env = self._launch(params.get("executablePath"), params.get("userDataDir") or DEFAULT_PROFILE,
                           params.get("port") or free_port(), bool(params.get("headless")))
        self.owned_browser = env.pop("_process")
        # A launched browser owns its own endpoint: an attach configured by an earlier call must not
        # keep pointing the connection layer at a browser this Session no longer drives.
        os.environ.pop("BU_CDP_URL", None)
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

    def evaluate(self, params):
        """One JavaScript expression in the owned page, answered as text. Produces no observation.

        This runs on the session's existing CDP connection on purpose: the caller must never need a
        second client, because Chrome 144+ raises one "Allow remote debugging?" prompt per
        connection and a second driver would race this one. The expression gets no user gesture, and
        a throw is reported as ``js_error`` — the page is not treated as changed, since nothing was
        executed on its behalf.
        """
        if self.browser is None:
            raise BridgeError("no_session", "Open a page first.")
        expression = params.get("expression")
        if not isinstance(expression, str) or not expression.strip():
            raise BridgeError("bad_request", "evaluate needs a JavaScript expression")
        try:
            response = self.browser.call(
                "Runtime.evaluate",
                expression=expression,
                returnByValue=True,
                awaitPromise=True,
                userGesture=False,
                timeout=evaluate_timeout(params.get("timeout_ms")),
            )
        except LostSession as error:
            self.browser, self.page, self.history = None, None, []
            raise BridgeError("lost_session", str(error)) from None
        except RuntimeError as error:
            raise BridgeError("browser_error", str(error)) from None
        if response.get("exceptionDetails"):
            raise BridgeError("js_error", exception_text(response["exceptionDetails"]))
        text = evaluated(response.get("result", {}))
        return {"text": text[:MAX_EVAL_TEXT], "chars": len(text), "truncated": len(text) > MAX_EVAL_TEXT}

    def act(self, params):
        if self.browser is None or self.page is None:
            raise BridgeError("no_session", "Open a page first.")
        intent = (params.get("intent") or "").strip()
        operation, target = (params.get("operation") or "").strip().upper(), params.get("target")
        engine_env = params.get("engine_env") or {}
        if not operation and not intent:
            raise BridgeError("bad_request", "act needs an operation, or an intent for Jev to choose one")
        if operation:
            action = resolve_action(self.page, operation, target)
        if not params.get("fingerprint"):
            raise BridgeError("bad_request", "act needs the fingerprint of the observation it refers to")
        if params["fingerprint"] != self.page["fingerprint"]:
            raise BridgeError("stale", "The page changed since that observation. Choose from the new one.",
                              page=observation(self.page))
        decision = None
        if not operation:
            decision = self._decide(intent, engine_env)
            operation, target = decision["operation"], decision["target"]
            if operation in {"DONE", "BLOCKED"}:
                return {"decision": decision, "page": observation(self.page)}
            action = resolve_action(self.page, operation, target)
        text, generated = params.get("text"), None
        if action["kind"] == "fill" and not (isinstance(text, str) and text):
            if not intent:
                raise BridgeError("bad_request",
                                  "TYPE_TEXT needs the text to enter, or an intent the Jev text model writes it from")
            text, generated = self._write(intent, action, engine_env)
        try:
            executed = self.browser.act(action, self.page, text=text)
        except StalePage as error:
            # Nothing ran against the page: report the fresh observation instead of retrying.
            self.page = self.browser.observe(screenshot=False)
            raise BridgeError("stale", str(error), page=observation(self.page)) from None
        except LostSession as error:
            self.browser, self.page, self.history = None, None, []
            raise BridgeError("lost_session", str(error)) from None
        self.browser.settle(action["kind"])
        before = self.page["fingerprint"]
        self.page = self.browser.observe(screenshot=False)
        self.history = [*self.history, {
            "action": action["label"], "kind": action["kind"], "text": text, "operation": operation,
            "target": target, "page_changed": self.page["fingerprint"] != before,
        }][-10:]
        result = {
            "executed": {**executed, "operation": operation, "target": target, "label": action["label"]},
            "page": observation(self.page),
        }
        if decision is not None:
            result["decision"] = decision
        if generated is not None:
            result["generated_text"] = generated
        return result

    def _decide(self, intent, engine_env):
        """One choice of operation and target on the current observation. Spends model quota."""
        if decisions(engine_env) != "chat" and not str(engine_env.get("TYPESAFE_API_KEY") or "").strip():
            raise BridgeError("no_credentials",
                              "an intent needs a TypeSafe key: configure jev in the dsh-browser-use plugin "
                              "config, or set jev.decider: chat so the text model decides")
        try:
            with engine_environment(engine_env, endpoint=True):
                choice = choose(self.page, intent, self.history)
        except (RuntimeError, ValueError, OSError, KeyError, TypeError) as error:
            raise BridgeError("model_error", f"Jev could not choose an action: {error}") from None
        operation, target = choice["operation"], choice["target"]
        label = ""
        if operation not in {"DONE", "BLOCKED"}:
            label = next((a["label"] for a in self.page["actions"] if a["id"] == choice["choice"]), "")
        return {"operation": operation, "target": target, "label": label,
                "confidence": choice.get("confidence"), "model": choice.get("model")}

    def _write(self, intent, action, engine_env):
        """The value for one field, from the Jev text model. Spends model quota."""
        if not str(engine_env.get("TEXT_MODEL_API_KEY") or "").strip():
            raise BridgeError("no_credentials",
                              "TYPE_TEXT without text needs a text-model key: "
                              "configure jev in the dsh-browser-use plugin config")
        try:
            with engine_environment(engine_env):
                value, helper = field_text(field_context(intent, action, self.page, self.history))
        except NoTextValue as error:
            raise BridgeError("no_text", str(error)) from None
        except (RuntimeError, ValueError, OSError, KeyError, TypeError) as error:
            raise BridgeError("model_error", f"The Jev text model could not write the value: {error}") from None
        return value, {"value": value, "model": helper.get("model")}

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
        """Run the policy once, in its own tab. Spends model quota; never a retry."""
        from jev_ultrafast.agent import Agent
        from jev_ultrafast.model import NoTextValue

        url, goal = (params.get("url") or "").strip(), (params.get("goal") or "").strip()
        if not url or not goal:
            raise BridgeError("bad_request", "goal needs a url and a goal")
        # Endpoints and keys come from the plugin configuration with this one request; the engine
        # checkout's .env is deliberately not read, and nothing outlives the run.
        engine_env = params.get("engine_env") or {}
        if decisions(engine_env) != "chat" and not str(engine_env.get("TYPESAFE_API_KEY") or "").strip():
            raise BridgeError("no_credentials",
                              "browser_goal has no TypeSafe key: configure jev in the dsh-browser-use plugin "
                              "config, or set jev.decider: chat so the text model decides")
        self._connect(params)
        last = None
        try:
            with engine_environment(engine_env, endpoint=True), Agent(url, goal, screenshots=False) as agent:
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
        self.history = []
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


METHODS = ("hello", "open", "observe", "evaluate", "act", "screenshot", "diagnostics", "goal", "close", "shutdown")


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
