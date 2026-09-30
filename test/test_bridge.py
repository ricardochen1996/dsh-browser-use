"""Offline contracts for the sidecar: observation, offered targets, guarded execution.

The bridge is what the plugin's Node half drives, so these tests speak its protocol with a fake
browser and never open a real one. No paid APIs are called.
"""

import io
import json
import os
import sys
from pathlib import Path

import pytest
from jev_ultrafast.browser import StalePage, fingerprint

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sidecar"))
import bridge  # noqa: E402  the sidecar is a script beside this test, not an installed package


def page(*, url="https://example.test/", value="", clicks=0):
    state = {
        "url": url,
        "title": "Search",
        "text": "Search results",
        "scroll": {"y": 0, "height": 900},
        "actions": [
            {"id": "e1", "kind": "fill", "label": "Search", "role": "textbox", "value": value, "node": 10},
            {"id": "e2", "kind": "click", "label": "Search", "role": "textbox", "value": value, "node": 10},
            {"id": "e3", "kind": "click", "label": "Go", "role": "button", "value": "", "node": 20,
             "nearby": "clicks: %d" % clicks},
            {"id": "e4", "kind": "select", "label": "All", "role": "combobox", "value": "all",
             "current_value": "All", "node": 30},
            {"id": "e5", "kind": "select", "label": "Design", "role": "combobox", "value": "design",
             "current_value": "All", "node": 30},
            {"id": "wait", "kind": "wait", "label": "Wait"},
            {"id": "scroll_down", "kind": "scroll", "label": "Scroll down", "delta": 560},
        ],
    }
    state["fingerprint"] = fingerprint(state)
    return state


class FakeBrowser:
    """One observed page that answers exactly like Browser does for the calls the bridge makes."""

    def __init__(self, url, reuse=False, state=None):
        self.session = "session-1"
        self.state = state or page(url=url)
        self.calls = []

    def observe(self, screenshot=True):
        return dict(self.state)

    def act(self, action, state, text=None):
        self.calls.append((action["id"], text))
        if action["kind"] == "fill":
            self.state = page(value=text, clicks=len(self.calls))
        elif action["kind"] == "select":
            self.state = page(value=action["value"], clicks=len(self.calls))
        else:
            self.state = page(clicks=len(self.calls))
        return {"executed": action["id"]}

    def settle(self, kind, timeout=3.0, quiet=0.3):
        return None

    def call(self, method, **params):
        assert method == "Page.captureScreenshot"
        return {"data": "anBlZw=="}

    def evaluate(self, expression):
        return [1120, 780]

    def close(self):
        self.closed = True


@pytest.fixture()
def session(monkeypatch):
    # A configured endpoint keeps these tests away from launching a real browser; the launch path
    # has its own test below.
    monkeypatch.setenv("BU_CDP_WS", "ws://127.0.0.1:9/devtools/browser/test")
    made = []

    def open_browser(url, reuse=False):
        made.append(FakeBrowser(url, reuse=reuse))
        return made[-1]

    opened = bridge.Session(open_browser=open_browser, launch=pytest.fail)
    opened.browser = open_browser("https://example.test/")
    opened.page = opened.browser.observe()
    return opened


def test_open_launches_a_dedicated_browser_when_no_endpoint_is_configured(monkeypatch):
    monkeypatch.delenv("BU_CDP_WS", raising=False)
    monkeypatch.delenv("BU_NAME", raising=False)
    launched = []

    class FakeProcess:
        def terminate(self):
            launched.append("terminated")

        def wait(self, timeout=None):
            launched.append(("waited", timeout))
            return 0

        def kill(self):
            launched.append("killed")

    def launch(executable, user_data_dir, port, headless):
        launched.append((executable, str(user_data_dir), port, headless))
        return {"BU_CDP_WS": "ws://127.0.0.1:1234/devtools/browser/abc", "_process": FakeProcess()}

    opened = bridge.Session(open_browser=FakeBrowser, launch=launch)
    call(opened, "open", url="https://example.test/", mode="launch", headless=True, port=1234)
    assert launched[0][0] is None and launched[0][2:] == (1234, True)
    assert bridge.os.environ["BU_CDP_WS"] == "ws://127.0.0.1:1234/devtools/browser/abc"
    assert call(opened, "shutdown") == {"bye": True}
    # The browser is stopped and awaited, so a relaunch finds the profile released.
    assert [step for step in launched[1:]] == ["terminated", ("waited", 10)]


def test_attach_mode_without_an_endpoint_is_refused_before_any_browser_exists(monkeypatch):
    monkeypatch.delenv("BU_CDP_WS", raising=False)
    opened = bridge.Session(open_browser=pytest.fail, launch=pytest.fail)
    error = failure(opened, "open", url="https://example.test/", mode="attach")
    assert error["kind"] == "no_browser" and "cdpEndpoint" in error["message"]


def test_attach_takes_an_http_endpoint_and_drops_a_ws_url_that_would_outlive_it(monkeypatch):
    """Only the HTTP endpoint survives a restart: Chrome mints a new ws id every time it starts."""
    monkeypatch.setenv("BU_CDP_WS", "ws://127.0.0.1:1234/devtools/browser/stale")
    monkeypatch.delenv("BU_CDP_URL", raising=False)
    session = bridge.Session(open_browser=pytest.fail, launch=pytest.fail)
    session._connect({"mode": "attach", "cdpEndpoint": "http://127.0.0.1:9222"})
    assert bridge.os.environ["BU_CDP_URL"] == "http://127.0.0.1:9222"
    assert "BU_CDP_WS" not in bridge.os.environ


def test_attach_keeps_a_ws_endpoint_and_drops_the_resolving_one(monkeypatch):
    monkeypatch.setenv("BU_CDP_URL", "http://127.0.0.1:9222")
    monkeypatch.delenv("BU_CDP_WS", raising=False)
    session = bridge.Session(open_browser=pytest.fail, launch=pytest.fail)
    session._connect({"mode": "attach", "cdpEndpoint": "ws://127.0.0.1:9222/devtools/browser/abc"})
    assert bridge.os.environ["BU_CDP_WS"] == "ws://127.0.0.1:9222/devtools/browser/abc"
    assert "BU_CDP_URL" not in bridge.os.environ


def test_an_endpoint_that_is_not_a_url_is_refused(monkeypatch):
    monkeypatch.delenv("BU_CDP_WS", raising=False)
    opened = bridge.Session(open_browser=pytest.fail, launch=pytest.fail)
    error = failure(opened, "open", url="https://example.test/", mode="attach", cdpEndpoint="127.0.0.1:9222")
    assert error["kind"] == "bad_request" and "http(s) or ws(s)" in error["message"]


def call(session, method, **params):
    response = bridge.dispatch(session, {"id": 1, "method": method, "params": params})
    assert "result" in response, response
    return response["result"]


def failure(session, method, **params):
    response = bridge.dispatch(session, {"id": 1, "method": method, "params": params})
    assert "kind" in response, response
    return response


def test_a_hand_off_to_another_browser_says_which_profile_is_taken(tmp_path, monkeypatch):
    class HandedOff:
        def poll(self):
            return 0

    monkeypatch.setattr(bridge, "running_endpoint", lambda data_dir: None)
    monkeypatch.setattr(bridge, "start_browser", lambda command, port, data_dir: (None, HandedOff()))
    monkeypatch.setattr(bridge.time, "sleep", lambda seconds: None)  # the retry waits are not the subject
    with pytest.raises(bridge.BridgeError) as error:
        bridge.launch_browser(None, tmp_path / "profile", 1, False)
    assert error.value.kind == "browser_in_use"
    assert "already owns" in str(error.value)


def test_a_profile_lock_from_a_dead_browser_is_cleared_and_a_live_one_is_kept(tmp_path):
    lock = tmp_path / "SingletonLock"
    lock.symlink_to("HOSTNAME-999999999")  # a lock whose owner is gone only costs the next launch
    bridge.clear_stale_singleton(tmp_path)
    assert not lock.is_symlink()
    lock.symlink_to(f"HOSTNAME-{os.getpid()}")  # this test process is the live owner
    bridge.clear_stale_singleton(tmp_path)
    assert lock.is_symlink()


def test_a_browser_that_still_owns_the_profile_is_adopted_not_duplicated(tmp_path, monkeypatch):
    adopted = []
    monkeypatch.setattr(bridge, "running_endpoint", lambda data_dir: "ws://127.0.0.1:9999/devtools/browser/kept")
    monkeypatch.setattr(bridge, "owner_pid", lambda data_dir: 4321)
    monkeypatch.setattr(bridge, "restart_daemon", lambda *arguments, **keywords: adopted.append("daemon stopped"))
    environment = bridge.launch_browser(None, tmp_path / "profile", 1, False)
    assert environment["BU_CDP_WS"] == "ws://127.0.0.1:9999/devtools/browser/kept"
    assert isinstance(environment["_process"], bridge.AdoptedBrowser)
    assert environment["_process"].pid == 4321
    assert adopted == ["daemon stopped"]


def test_observation_offers_targets_without_exposing_the_dom(session):
    result = call(session, "observe")
    elements = result["page"]["elements"]
    assert [element["index"] for element in elements] == ["1", "2", "3"]
    assert sorted(result["page"]["operations"]) == ["CLICK", "SCROLL_DOWN", "SELECT", "TYPE_TEXT", "WAIT"]
    # A field that can be typed into is one element with two operations, not two elements.
    assert [element["label"] for element in elements] == ["Search", "Go", "All"]
    assert elements[0]["operations"] == ["TYPE_TEXT", "CLICK"]
    assert [option["label"] for option in elements[2]["options"]] == ["All", "Design"]
    assert result["page"]["operations"]["SELECT"] == ["3:1", "3:2"]
    # Nothing the model may not see: no node ids, no guards, no screenshot.
    assert "guards" not in result["page"] and "node" not in json.dumps(result["page"])
    assert result["page"]["fingerprint"]


def test_parameters_are_required_before_a_page_is_open():
    empty = bridge.Session(open_browser=pytest.fail, launch=pytest.fail)
    assert failure(empty, "observe")["kind"] == "no_session"
    assert failure(empty, "screenshot")["kind"] == "no_session"
    assert failure(empty, "act", operation="CLICK", target="1", fingerprint="x")["kind"] == "no_session"
    assert failure(empty, "open", url="")["kind"] == "bad_request"


def test_open_requires_a_url_and_reports_the_first_page(session):
    assert call(session, "close") == {"closed": True}
    result = call(session, "open", url="https://example.test/next")
    assert result["page"]["url"] == "https://example.test/next"


def test_click_runs_the_offered_target_and_returns_the_next_observation(session):
    before = session.page["fingerprint"]
    result = call(session, "act", operation="CLICK", target="2", fingerprint=before)
    assert result["executed"]["executed"] == "e3"
    assert result["executed"]["label"] == "Go"
    assert session.browser.calls == [("e3", None)]
    assert result["page"]["fingerprint"] != before


def test_type_text_needs_words_and_a_fill_target(session):
    assert failure(session, "act", operation="TYPE_TEXT", target="1",
                   fingerprint=session.page["fingerprint"])["kind"] == "bad_request"
    # The same element also offers CLICK, and a click carries no text.
    assert call(session, "act", operation="CLICK", target="1",
                fingerprint=session.page["fingerprint"])["executed"]["executed"] == "e2"


def test_select_uses_the_observed_option_target(session):
    result = call(session, "act", operation="SELECT", target="3:2", fingerprint=session.page["fingerprint"])
    assert result["executed"]["executed"] == "e5"
    assert session.browser.calls == [("e5", None)]


def test_operations_and_targets_that_were_not_offered_are_refused(session):
    unsupported = failure(session, "act", operation="PRESS_KEY", target="1",
                          fingerprint=session.page["fingerprint"])
    assert unsupported["kind"] == "unsupported_operation"
    assert "CLICK" in unsupported["message"]
    missing = failure(session, "act", operation="CLICK", target="9",
                      fingerprint=session.page["fingerprint"])
    assert missing["kind"] == "unsupported_target"
    # A scroll takes no target, and a target on it is a caller mistake rather than a page change.
    assert failure(session, "act", operation="SCROLL_DOWN", target="1",
                   fingerprint=session.page["fingerprint"])["kind"] == "unsupported_target"
    assert session.browser.calls == []


def test_a_stale_fingerprint_is_refused_with_the_page_the_caller_must_use(session):
    error = failure(session, "act", operation="CLICK", target="2", fingerprint="outdated")
    assert error["kind"] == "stale"
    assert error["page"]["fingerprint"] == session.page["fingerprint"]
    assert session.browser.calls == []


def test_an_action_the_page_refused_reports_fresh_state_and_is_never_retried(session):
    def refuse(action, state, text=None):
        session.browser.calls.append((action["id"], text))
        raise StalePage("Target changed or is covered. Observe again.")

    session.browser.act = refuse
    error = failure(session, "act", operation="CLICK", target="2", fingerprint=session.page["fingerprint"])
    assert error["kind"] == "stale"
    assert "Observe again" in error["message"]
    assert error["page"]["elements"]
    assert len(session.browser.calls) == 1


def test_a_lost_session_end_the_bridge_session_instead_of_retrying(session):
    def lost(action, state, text=None):
        raise bridge.LostSession("Session with given id not found")

    session.browser.act = lost
    error = failure(session, "act", operation="CLICK", target="2", fingerprint=session.page["fingerprint"])
    assert error["kind"] == "lost_session"
    assert session.browser is None and session.page is None


def test_screenshot_reports_the_viewport_it_captured(session):
    assert call(session, "screenshot") == {"jpeg_base64": "anBlZw==", "width": 1120, "height": 780}


def test_diagnostics_keep_only_this_sessions_console_and_failures(monkeypatch, session):
    events = [
        {"session_id": "session-1", "method": "Runtime.consoleAPICalled",
         "params": {"type": "error", "args": [{"value": "Uncaught"}]}},
        {"session_id": "session-2", "method": "Runtime.consoleAPICalled",
         "params": {"type": "log", "args": [{"value": "another tab"}]}},
        {"session_id": "session-1", "method": "Network.requestWillBeSent",
         "params": {"requestId": "1", "request": {"url": "https://example.test/missing"}}},
        {"session_id": "session-1", "method": "Network.loadingFailed",
         "params": {"requestId": "1", "errorText": "net::ERR_FAILED"}},
        {"session_id": "session-1", "method": "Network.responseReceived",
         "params": {"requestId": "2", "response": {"status": 503, "url": "https://example.test/api"}}},
        {"session_id": "session-1", "method": "Runtime.exceptionThrown",
         "params": {"exceptionDetails": {"text": "Uncaught TypeError", "lineNumber": 12,
                                         "exception": {"description": "TypeError: x is not a function"}}}},
    ]
    monkeypatch.setattr(bridge, "drain_events", lambda: events)
    report = call(session, "diagnostics")
    assert [entry["text"] for entry in report["console"]] == ["Uncaught", "TypeError: x is not a function"]
    assert report["exceptions"] == [{"text": "Uncaught TypeError", "line": 12}]
    assert report["failed_requests"] == [
        {"url": "https://example.test/missing", "error": "net::ERR_FAILED", "canceled": False}
    ]
    assert report["error_responses"] == [{"status": 503, "url": "https://example.test/api"}]
    assert report["url"] == "https://example.test/"


def test_goal_mode_reports_the_policy_trace_and_needs_both_arguments(session, monkeypatch):
    from jev_ultrafast import agent as agent_module

    seen = {}

    class FakeAgent:
        def __init__(self, url, goal, **options):
            seen.update(url=url, goal=goal, options=options)
            self.state = {
                "goal": goal,
                "elapsed_ms": 1234,
                "status": "done",
                "text_calls": [{"field": "Search", "value": "flights"}],
                "history": [{"step": 1, "operation": "CLICK", "action": "Go", "text": None,
                             "page_changed": True, "url": url}],
            }

        def run(self):
            yield self.state

        def __enter__(self):
            return self

        def __exit__(self, *arguments):
            return False

    monkeypatch.setattr(agent_module, "Agent", FakeAgent)
    assert failure(session, "goal", url="https://example.test/", goal="")["kind"] == "bad_request"
    result = call(session, "goal", url="https://example.test/", goal="Find the first result")
    assert seen == {"url": "https://example.test/", "goal": "Find the first result", "options": {"screenshots": False}}
    assert result["status"] == "done" and result["steps"] == 1
    assert result["history"][0]["operation"] == "CLICK"
    assert result["text_calls"] == [{"field": "Search", "value": "flights"}]


@pytest.mark.parametrize("configured", [None, "/does/not/exist"])
def test_a_missing_browser_is_reported_with_the_setting_that_fixes_it(configured, monkeypatch):
    monkeypatch.setattr(bridge.shutil, "which", lambda _name: None)
    monkeypatch.setattr(bridge.Path, "exists", lambda _self: False)
    with pytest.raises(bridge.BridgeError) as error:
        bridge.browser_executable(configured)
    assert error.value.kind == "no_browser"
    assert "executablePath" in str(error.value)


def test_serve_answers_in_order_and_stops_on_shutdown(monkeypatch, session):
    monkeypatch.setattr(bridge, "Session", lambda **kw: session)
    requests = "\n".join([
        json.dumps({"id": 1, "method": "hello"}),
        "{not json}",
        json.dumps({"id": 3, "method": "nope"}),
        json.dumps({"id": 4, "method": "close"}),
        json.dumps({"id": 5, "method": "shutdown"}),
    ])
    instream, outstream = io.StringIO(requests), io.StringIO()
    bridge.serve(instream, outstream)
    answers = [json.loads(line) for line in outstream.getvalue().splitlines()]
    assert [answer.get("id") for answer in answers] == [1, None, 3, 4, 5]
    assert answers[0]["result"]["protocol"] == bridge.PROTOCOL
    assert answers[1]["error"]["kind"] == "bad_request"
    assert answers[2]["error"]["kind"] == "unknown_method"
    assert answers[3]["result"] == {"closed": True}
    assert answers[4]["result"] == {"bye": True}
