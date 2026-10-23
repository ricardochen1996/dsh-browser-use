"""Offline contracts for the sidecar: observation, offered targets, guarded execution.

The bridge is what the plugin's Node half drives, so these tests speak its protocol with a fake
browser and never open a real one. No paid APIs are called.
"""

import http.server
import io
import json
import os
import sys
import threading
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
        # What an expression answers, and which expressions were run: the evaluate path has no page
        # to look at, so the test states the reply instead of trusting a browser to agree with it.
        self.replies = {}
        self.evaluated = []

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
        if method == "Runtime.evaluate":
            # The one seam an expression crosses; a reply is keyed by the expression itself, so a
            # test says what the page would answer without a page.
            self.evaluated.append(params)
            return self.replies.get(params["expression"], {"result": {"type": "undefined"}})
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


def test_attach_without_an_endpoint_hands_discovery_to_browser_harness(monkeypatch, tmp_path):
    """Your own Chrome is found only while no endpoint is set, so an earlier one is dropped."""
    monkeypatch.setenv("BU_CDP_WS", "ws://127.0.0.1:1234/devtools/browser/earlier")
    monkeypatch.setenv("BU_CDP_URL", "http://127.0.0.1:1234")
    checked = []
    monkeypatch.setattr(bridge, "discover_local_browser", lambda: checked.append(True) or tmp_path)
    session = bridge.Session(open_browser=pytest.fail, launch=pytest.fail)
    session._connect({"mode": "attach"})
    assert checked == [True]
    assert "BU_CDP_WS" not in bridge.os.environ and "BU_CDP_URL" not in bridge.os.environ
    assert session.owned_browser is None  # a browser you started is never one this sidecar stops


def test_closing_an_attached_browser_closes_the_tab_and_never_the_browser(monkeypatch):
    """Letting Sessions share an external browser must not end with one of them stopping it.

    Attach mode owns no browser process — sharing has no knob of its own down here, because attach
    is the mode that can be shared — so whatever the Sessions share belongs to whoever started it.
    Closing this Session stops its tab and its own daemon, and there is no process here that could
    be terminated: the browser the other Sessions are still driving stays up.
    """
    monkeypatch.setenv("BU_CDP_WS", "ws://placeholder")  # restored (absent) when this test ends
    ended = []
    monkeypatch.setattr(bridge, "restart_daemon", lambda *arguments, **keywords: ended.append("daemon stopped"))
    closed = []

    class FakeBrowser:
        def close(self):
            closed.append("tab closed")

    session = bridge.Session(open_browser=pytest.fail, launch=pytest.fail)
    session._connect({"mode": "attach", "cdpEndpoint": "ws://127.0.0.1:9/devtools/browser/shared"})
    assert session.owned_browser is None  # nothing here may terminate the shared browser
    session.browser = FakeBrowser()
    assert call(session, "shutdown") == {"bye": True}
    assert closed == ["tab closed"] and ended == ["daemon stopped"]


def test_attach_without_an_endpoint_says_what_is_missing_before_any_browser_exists(monkeypatch, tmp_path):
    monkeypatch.setattr(bridge.socket, "create_connection", lambda *arguments, **keywords: pytest.fail())
    discover = bridge.discover_local_browser
    monkeypatch.setattr(bridge, "discover_local_browser", lambda: discover([tmp_path / "Chrome"]))
    opened = bridge.Session(open_browser=pytest.fail, launch=pytest.fail)
    error = failure(opened, "open", url="https://example.test/", mode="attach")
    assert error["kind"] == "no_browser" and "chrome://inspect/#remote-debugging" in error["message"]


def test_discovery_finds_the_profile_whose_debugging_port_is_live(tmp_path):
    stale, live = tmp_path / "Chrome Canary", tmp_path / "Chrome"
    stale.mkdir()
    live.mkdir()
    with bridge.socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        closed = bridge.free_port()  # nothing listens here: a browser that quit left its file behind
        (stale / "DevToolsActivePort").write_text(f"{closed}\n/devtools/browser/gone\n")
        (live / "DevToolsActivePort").write_text(f"{listener.getsockname()[1]}\n/devtools/browser/abc\n")
        assert bridge.discover_local_browser([tmp_path / "Missing", stale, live]) == live


def test_discovery_that_is_denied_the_profile_asks_for_full_disk_access(tmp_path, monkeypatch):
    profile = tmp_path / "Chrome"
    profile.mkdir()
    (profile / "DevToolsActivePort").write_text("9222\n/devtools/browser/abc\n")
    real_read = Path.read_text

    def denied(path, *arguments, **keywords):
        if path.name == "DevToolsActivePort":
            raise PermissionError(1, "Operation not permitted")
        return real_read(path, *arguments, **keywords)

    monkeypatch.setattr(Path, "read_text", denied)
    with pytest.raises(bridge.BridgeError) as error:
        bridge.discover_local_browser([profile])
    assert error.value.kind == "no_permission" and "Full Disk Access" in str(error.value)


def test_an_unknown_mode_is_refused(monkeypatch):
    monkeypatch.delenv("BU_CDP_WS", raising=False)
    opened = bridge.Session(open_browser=pytest.fail, launch=pytest.fail)
    error = failure(opened, "open", url="https://example.test/", mode="borrow")
    assert error["kind"] == "bad_request" and "unknown mode" in error["message"]


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
    monkeypatch.setattr(bridge, "start_browser", lambda command, port, data_dir, output=None: (None, HandedOff()))
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
    assert failure(empty, "evaluate", expression="1")["kind"] == "no_session"
    assert failure(empty, "open", url="")["kind"] == "bad_request"


def test_evaluate_answers_on_the_session_connection_without_an_observation(session):
    """The whole point of evaluate: a programmatic read over the connection the Session already owns.

    Nothing here opens a second CDP client — the fake browser has exactly one — and a result is text,
    not a new observation: the guard a later action needs still belongs to the page it was read in.
    """
    before = session.page["fingerprint"]
    session.browser.replies["document.title"] = {"result": {"type": "string", "value": "Search"}}
    result = call(session, "evaluate", expression="document.title")
    assert result == {"text": "Search", "chars": 6, "truncated": False}
    assert session.page["fingerprint"] == before  # no observation was produced
    assert session.browser.evaluated[-1]["userGesture"] is False
    assert session.browser.evaluated[-1]["timeout"] == bridge.EVAL_TIMEOUT_MS


def test_evaluate_renders_a_value_as_json_and_caps_what_it_returns(session):
    session.browser.replies["list"] = {"result": {"type": "object", "value": [1, "two"]}}
    assert call(session, "evaluate", expression="list")["text"] == '[1, "two"]'
    session.browser.replies["node"] = {"result": {"type": "object", "subtype": "node", "description": "div.app"}}
    assert call(session, "evaluate", expression="node")["text"] == "div.app"
    session.browser.replies["long"] = {"result": {"type": "string", "value": "x" * 20000}}
    capped = call(session, "evaluate", expression="long")
    assert capped["chars"] == 20000 and capped["truncated"] is True
    assert len(capped["text"]) == bridge.MAX_EVAL_TEXT


def test_evaluate_reports_a_thrown_expression_as_a_refusal_not_as_a_lost_page(session):
    session.browser.replies["null.x"] = {
        "result": {"type": "object"},
        "exceptionDetails": {"text": "Uncaught", "exception": {"description": "TypeError: null is not an object"}},
    }
    error = failure(session, "evaluate", expression="null.x")
    assert error["kind"] == "js_error" and "TypeError: null is not an object" in error["message"]
    assert session.browser is not None and session.page is not None  # the page is fine; only the expression threw
    assert failure(session, "evaluate", expression="  ")["kind"] == "bad_request"


def test_evaluate_answers_text_the_stdio_protocol_can_carry(session):
    """An expression can return a string no DOM ever holds; the write must not end the sidecar."""
    session.browser.replies["weird"] = {"result": {"type": "string", "value": "\ud800"}}
    result = call(session, "evaluate", expression="weird")
    result["text"].encode("utf-8")  # a lone surrogate would raise here, on the request that carried it


def test_evaluate_timeout_is_clamped_to_the_cap_and_the_default():
    assert bridge.evaluate_timeout(None) == bridge.EVAL_TIMEOUT_MS
    assert bridge.evaluate_timeout("soon") == bridge.EVAL_TIMEOUT_MS
    assert bridge.evaluate_timeout(10) == 1000
    assert bridge.evaluate_timeout(10**9) == bridge.EVAL_TIMEOUT_MAX_MS


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
    assert session.browser.calls == []  # without an intent there is nothing to write the value from
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
    result = call(session, "goal", url="https://example.test/", goal="Find the first result",
                  engine_env={"TYPESAFE_API_KEY": "from-plugin-config"})
    assert seen == {"url": "https://example.test/", "goal": "Find the first result", "options": {"screenshots": False}}
    assert result["status"] == "done" and result["steps"] == 1
    assert result["history"][0]["operation"] == "CLICK"
    assert result["text_calls"] == [{"field": "Search", "value": "flights"}]


def test_goal_mode_needs_a_key_from_the_plugin_config_and_never_reads_the_engine_env_file(session, monkeypatch):
    from jev_ultrafast import agent as agent_module

    def refuse(*arguments, **options):
        raise AssertionError("the agent must not start without a key")

    monkeypatch.setattr(agent_module, "Agent", refuse)
    monkeypatch.setenv("TYPESAFE_API_KEY", "ambient-must-not-count")
    error = failure(session, "goal", url="https://example.test/", goal="Find it")
    assert error["kind"] == "no_credentials" and "jev" in error["message"]
    assert "jev.decider: chat" in error["message"], "the refusal names the mode that needs no TypeSafe key"
    assert "request_environment" not in vars(bridge)


def test_goal_mode_sees_exactly_the_variables_of_its_request_and_none_after(session, monkeypatch):
    from jev_ultrafast import agent as agent_module

    seen = {}

    class FakeAgent:
        def __init__(self, url, goal, **options):
            seen.update({name: bridge.os.environ.get(name) for name in bridge.ENGINE_VARIABLES})

        def run(self):
            yield {"status": "done", "elapsed_ms": 1, "history": [], "text_calls": []}

        def __enter__(self):
            return self

        def __exit__(self, *arguments):
            return False

    monkeypatch.setattr(agent_module, "Agent", FakeAgent)
    monkeypatch.setenv("TEXT_MODEL", "ambient-model")
    call(session, "goal", url="https://example.test/", goal="Find it",
         engine_env={"TYPESAFE_API_KEY": "k1", "TEXT_MODEL_API_KEY": "k2", "TEXT_MODEL_BASE_URL": "https://gw.test/v1"})
    assert seen["TYPESAFE_API_KEY"] == "k1" and seen["TEXT_MODEL_API_KEY"] == "k2"
    assert seen["TEXT_MODEL_BASE_URL"] == "https://gw.test/v1" and seen["TEXT_MODEL"] is None
    assert not any(name in bridge.os.environ for name in bridge.ENGINE_VARIABLES)


def test_goal_mode_with_a_chat_decider_aims_the_loop_at_its_endpoint_without_a_key(session, monkeypatch):
    """`jev.decider: chat`: the text model answers, so no TypeSafe key is required or looked for."""
    from jev_ultrafast import agent as agent_module

    seen = {}

    class FakeAgent:
        def __init__(self, url, goal, **options):
            seen.update({name: bridge.os.environ.get(name) for name in bridge.ENGINE_VARIABLES})

        def run(self):
            yield {"status": "done", "elapsed_ms": 1, "history": [], "text_calls": []}

        def __enter__(self):
            return self

        def __exit__(self, *arguments):
            return False

    monkeypatch.setattr(agent_module, "Agent", FakeAgent)
    result = call(session, "goal", url="https://example.test/", goal="Find it",
                  engine_env={"JEV_DECIDER": "chat", "TEXT_MODEL_API_KEY": "k2",
                              "TEXT_MODEL_BASE_URL": "https://chat.test/v1", "TEXT_MODEL": "chat-1"})
    assert result["status"] == "done"
    assert seen["JEV_DECIDER"] == "chat" and seen["TYPESAFE_API_KEY"] is None
    assert seen["TYPESAFE_BASE_URL"].startswith("http://127.0.0.1:") and seen["TYPESAFE_MODEL"] == "chat-1"
    assert not any(name in bridge.os.environ for name in bridge.ENGINE_VARIABLES)


def test_an_intent_lets_jev_choose_the_step_with_exactly_the_request_variables(session, monkeypatch):
    seen = {}

    def choose(state, goal, history):
        seen.update(goal=goal, history=list(history),
                    env={name: bridge.os.environ.get(name) for name in bridge.ENGINE_VARIABLES})
        return {"choice": "e3", "operation": "CLICK", "target": "2", "confidence": 0.9, "model": "jev-1"}

    monkeypatch.setattr(bridge, "choose", choose)
    result = call(session, "act", intent="Submit the search", fingerprint=session.page["fingerprint"],
                  engine_env={"TYPESAFE_API_KEY": "k1"})
    assert seen["goal"] == "Submit the search" and seen["history"] == []
    assert seen["env"]["TYPESAFE_API_KEY"] == "k1"
    assert not any(name in bridge.os.environ for name in bridge.ENGINE_VARIABLES)
    assert session.browser.calls == [("e3", None)]
    assert result["decision"] == {
        "operation": "CLICK", "target": "2", "label": "Go", "confidence": 0.9, "model": "jev-1",
    }
    assert result["executed"]["operation"] == "CLICK" and result["executed"]["label"] == "Go"
    # The next choice sees what just ran, so a click the page ignored is not chosen again.
    call(session, "act", intent="Submit the search", fingerprint=session.page["fingerprint"],
         engine_env={"TYPESAFE_API_KEY": "k1"})
    assert seen["history"][0]["operation"] == "CLICK" and seen["history"][0]["page_changed"] is True


def test_a_jev_verdict_of_done_executes_nothing(session, monkeypatch):
    monkeypatch.setattr(bridge, "choose", lambda state, goal, history: {
        "choice": "DONE", "operation": "DONE", "target": None, "confidence": 0.8, "model": "jev-1"})
    result = call(session, "act", intent="Search", fingerprint=session.page["fingerprint"],
                  engine_env={"TYPESAFE_API_KEY": "k1"})
    assert result["decision"]["operation"] == "DONE" and "executed" not in result
    assert session.browser.calls == []


def test_a_chat_decider_answers_an_intent_over_loopback_with_no_typesafe_key(session, monkeypatch):
    """With `jev.decider: chat` the sidecar serves a real System One endpoint for the one call.

    The whole path is exercised: the loop posts its factored questions to the loopback URL the sidecar
    just pointed it at, the endpoint asks the chat model (stubbed here, so no network and no key), and
    the answer comes back as a decision the browser then executes.
    """
    from jev_ultrafast import llm_endpoint

    asked = {}

    def ask(self, messages):
        asked.update(model=self.model, payload=json.loads(messages[-1]["content"]))
        return json.dumps({"action": "CLICK 2", "confidence": 0.9})

    monkeypatch.setattr(llm_endpoint.Chooser, "ask", ask)
    result = call(session, "act", intent="Press Go", fingerprint=session.page["fingerprint"],
                  engine_env={"JEV_DECIDER": "chat", "TEXT_MODEL_API_KEY": "k2",
                              "TEXT_MODEL_BASE_URL": "https://chat.test/v1", "TEXT_MODEL": "chat-1"})
    assert asked["model"] == "chat-1" and asked["payload"]["goal"] == "Press Go"
    assert "CLICK 2" in asked["payload"]["actions"], "the chat model reads the actions the loop offers"
    assert session.browser.calls == [("e3", None)]
    assert result["decision"]["operation"] == "CLICK" and result["decision"]["label"] == "Go"
    assert result["decision"]["model"] == "chat:chat-1"
    # The endpoint lives for exactly this call, and nothing it needed outlives it.
    assert not any(name in bridge.os.environ for name in bridge.ENGINE_VARIABLES)


def test_type_text_without_text_takes_its_value_from_the_jev_text_model(session, monkeypatch):
    seen = {}

    def field_text(context):
        seen.update(context=context, key=bridge.os.environ.get("TEXT_MODEL_API_KEY"))
        return "flights to Tokyo", {"model": "flash", "latency_ms": 1, "usage": {}}

    monkeypatch.setattr(bridge, "field_text", field_text)
    monkeypatch.setattr(bridge, "choose", lambda *arguments: pytest.fail("an explicit operation needs no choice"))
    result = call(session, "act", operation="TYPE_TEXT", target="1", intent="Search for flights to Tokyo",
                  fingerprint=session.page["fingerprint"], engine_env={"TEXT_MODEL_API_KEY": "k2"})
    assert seen["key"] == "k2" and seen["context"]["goal"] == "Search for flights to Tokyo"
    assert session.browser.calls == [("e1", "flights to Tokyo")]
    assert result["generated_text"] == {"value": "flights to Tokyo", "model": "flash"}
    assert "decision" not in result


def test_an_intent_without_the_key_it_needs_spends_nothing(session, monkeypatch):
    monkeypatch.setattr(bridge, "choose", lambda *arguments: pytest.fail("no key, no model call"))
    monkeypatch.setattr(bridge, "field_text", lambda *arguments: pytest.fail("no key, no model call"))
    monkeypatch.setenv("TYPESAFE_API_KEY", "ambient-must-not-count")
    fingerprint = session.page["fingerprint"]
    assert failure(session, "act", intent="Search", fingerprint=fingerprint)["kind"] == "no_credentials"
    assert failure(session, "act", operation="TYPE_TEXT", target="1", intent="Search",
                   fingerprint=fingerprint, engine_env={"TYPESAFE_API_KEY": "k1"})["kind"] == "no_credentials"
    assert failure(session, "act", fingerprint=fingerprint)["kind"] == "bad_request"
    assert failure(session, "act", intent="Search", fingerprint="outdated")["kind"] == "stale"
    assert session.browser.calls == []


def test_a_model_that_fails_is_reported_and_nothing_runs(session, monkeypatch):
    def unavailable(*arguments):
        raise RuntimeError("Model unavailable")

    monkeypatch.setattr(bridge, "choose", unavailable)
    error = failure(session, "act", intent="Search", fingerprint=session.page["fingerprint"],
                    engine_env={"TYPESAFE_API_KEY": "k1"})
    assert error["kind"] == "model_error" and "Model unavailable" in error["message"]

    def no_value(context):
        raise bridge.NoTextValue("Text helper returned no valid field value; nothing typed.")

    monkeypatch.setattr(bridge, "field_text", no_value)
    error = failure(session, "act", operation="TYPE_TEXT", target="1", intent="Search",
                    fingerprint=session.page["fingerprint"], engine_env={"TEXT_MODEL_API_KEY": "k2"})
    assert error["kind"] == "no_text"
    assert session.browser.calls == []


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


class Running:
    """A browser process that is still up, which is what a launch waiting on its endpoint holds."""

    def poll(self):
        return None


def failing_launch(message="", recorded_port=None):
    """A launcher that behaves like a browser which runs but never publishes an endpoint."""

    def start(command, port, data_dir, output=None):
        if recorded_port is not None:
            Path(data_dir, "DevToolsActivePort").write_text(f"{recorded_port}\n/devtools/browser/abc\n")
        if message and output is not None:
            Path(output).write_text(message)
        return None, Running()

    return start


def test_a_launch_that_never_publishes_quotes_what_the_browser_printed(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, "browser_executable", lambda configured: "chrome-under-test")
    monkeypatch.setattr(bridge, "running_endpoint", lambda data_dir: None)
    monkeypatch.setattr(bridge, "start_browser",
                        failing_launch("DevTools remote debugging port 49312 is already in use\n"))
    with pytest.raises(bridge.BridgeError) as error:
        bridge.launch_browser(None, tmp_path / "profile", 49312, False)
    message = str(error.value)
    assert error.value.kind == "no_browser"
    assert "The browser did not open a DevTools endpoint within 25s" in message
    # The three facts a person needs: what was run, where, and what it said.
    assert "chrome-under-test" in message and str(tmp_path / "profile") in message and "49312" in message
    assert "port 49312 is already in use" in message


def test_a_launch_that_never_publishes_names_the_port_the_profile_recorded(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, "browser_executable", lambda configured: "chrome-under-test")
    monkeypatch.setattr(bridge, "running_endpoint", lambda data_dir: None)
    monkeypatch.setattr(bridge, "start_browser", failing_launch("", recorded_port=4711))
    with pytest.raises(bridge.BridgeError) as error:
        bridge.launch_browser(None, tmp_path / "profile", 4712, False)
    assert "records DevTools on port 4711, not 4712" in str(error.value)


def test_a_launch_without_a_recorded_port_says_remote_debugging_never_started(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, "browser_executable", lambda configured: "chrome-under-test")
    monkeypatch.setattr(bridge, "running_endpoint", lambda data_dir: None)
    monkeypatch.setattr(bridge, "start_browser", failing_launch(""))
    with pytest.raises(bridge.BridgeError) as error:
        bridge.launch_browser(None, tmp_path / "profile", 4713, False)
    assert "never enabled remote debugging" in str(error.value)


def test_the_endpoint_probe_is_a_loopback_request_and_never_uses_a_proxy(monkeypatch):
    """A proxy that does not exclude 127.0.0.1 must not answer for a browser that is listening."""

    class Version(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'{"webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/kept"}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *arguments):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Version)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        # The proxy is set to a port nothing answers on, and the bypass list is made to miss the
        # loopback address, which is how a proxy that does not exclude it behaves on macOS.
        for name in ("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"):
            monkeypatch.setenv(name, "http://127.0.0.1:9")
        monkeypatch.setattr(bridge.urllib.request, "proxy_bypass", lambda host: False)
        assert bridge.devtools_endpoint(server.server_address[1]) == "ws://127.0.0.1:9222/devtools/browser/kept"
    finally:
        server.shutdown()
        server.server_close()


def test_the_probe_answers_none_while_a_browser_is_still_starting():
    """Nothing listening is not an error: it is the state a launch spends 25s checking."""
    assert bridge.devtools_endpoint(bridge.free_port(), timeout=0.2) is None
