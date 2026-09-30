"""Speed benchmark: the same browser task with Jev on and with Jev off.

Both arms drive the same sidecar Session (the code `browser_act` runs) on the same local page with
the same goal, in a headless browser of their own:

  jev   every step is `browser_act({intent})`: TypeSafe chooses operation + target, and the Jev text
        model writes TYPE_TEXT values.
  llm   every step is one turn of the chat model (OpenAI Responses API) reading the same page table
        the plugin shows it, and answering with a browser_act tool call. The prompt is much smaller
        than a real DSH turn, so this arm is measured under favourable conditions.

The clock starts at the first decision after the page is open and stops at the DONE / finish
decision, as in the upstream measurements. Every run is checked independently afterwards.

Spends model quota. Keys come only from the environment:

  TYPESAFE_API_KEY, TYPESAFE_BASE_URL, TYPESAFE_MODEL          the jev arm's decisions
  TEXT_MODEL_API_KEY, TEXT_MODEL_BASE_URL, TEXT_MODEL,
  TEXT_MODEL_REASONING, TEXT_MODEL_HEADERS                     the jev arm's text model
  LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_HEADERS            the llm arm (defaults: TEXT_MODEL_*)

  .venv/bin/python bench/speed.py --runs 3 --effort max --effort low --out bench/results.json
"""

import argparse
import functools
import http.server
import json
import os
import statistics
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "sidecar"))

import bridge  # noqa: E402

GOAL = ("Search for stays in Lisbon with free cancellation and breakfast included, then click the "
        "Casa Flora result so its booking page is open.")
MAX_STEPS = 12
ENGINE_KEYS = ("TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_MODEL", "TYPESAFE_FALLBACK_URL",
               "TEXT_MODEL_API_KEY", "TEXT_MODEL_BASE_URL", "TEXT_MODEL", "TEXT_MODEL_REASONING",
               "TEXT_MODEL_HEADERS")

SYSTEM = (
    "You operate a web browser for the user through the browser_act tool. Each tool result is the page "
    "as an indexed action space: one line per reachable element, with the operations it supports. "
    "Call browser_act with exactly one operation and the element index as target (TYPE_TEXT also "
    "needs text). Act on the latest table only. When the goal is achieved and visible on the page, "
    "call finish."
)
TOOLS = [
    {"type": "function", "name": "browser_act", "description": "Run one operation on one target.",
     "parameters": {"type": "object", "properties": {
         "operation": {"type": "string", "enum": ["CLICK", "TYPE_TEXT", "SELECT", "SCROLL_UP", "SCROLL_DOWN", "WAIT"]},
         "target": {"type": "string", "description": "Element index from the latest table"},
         "text": {"type": "string", "description": "Text to enter, for TYPE_TEXT"}},
         "required": ["operation"]}},
    {"type": "function", "name": "finish", "description": "The goal is achieved.",
     "parameters": {"type": "object", "properties": {"summary": {"type": "string"}}}},
]


def page_text(page, observation):
    """Python twin of lib/tools.js pageText: the table the plugin shows a model."""
    def collapse(value):
        return " ".join(str(value or "").split())
    lines = [f"Page {page['url']}" + (f" — {page['title']}" if page.get("title") else ""),
             f"Observation {observation}. Targets below are valid only for this observation."]
    text = collapse(page.get("text"))
    if text:
        lines.append(f"Visible text: {text[:1200]}{'…' if len(text) > 1200 else ''}")
    for element in page.get("elements") or []:
        value = collapse(element.get("value"))
        details = " ".join(filter(None, [element.get("role") or "element", collapse(element.get("label"))]))
        states = []
        for key, on, off in (("checked", "checked", "not checked"), ("selected", "selected", "not selected"),
                             ("expanded", "expanded", "collapsed")):
            state = str(element.get(key, ""))
            states += [on] if state == "true" else [off] if state == "false" else [f"partly {on}"] if state == "mixed" else []
        lines.append(f"[{element['index']}] {details}" + (f' · "{value}"' if value else "")
                     + (f" ({', '.join(states)})" if states else "") + f" — {', '.join(element['operations'])}")
        for option in element.get("options") or []:
            lines.append(f"      {option['index']} → {collapse(option['label'])}")
    bare = [name for name, targets in (page.get("operations") or {}).items() if not targets]
    if bare:
        lines.append(f"Without a target: {', '.join(bare)}")
    return "\n".join(lines)


def serve_fixture():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    handler = functools.partial(Quiet, directory=str(HERE))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/fixture.html"


def verified(session):
    state = session.browser.evaluate(
        "JSON.stringify({title: document.title, city: document.getElementById('city').value,"
        " free: document.getElementById('free').checked, breakfast: document.getElementById('breakfast').checked})")
    state = json.loads(state)
    ok = ("Casa Flora —" in state["title"] and state["city"].strip().lower() == "lisbon"
          and state["free"] and state["breakfast"])
    return ok, state


def timed(record, key, fn):
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            record.setdefault(key, []).append(round((time.perf_counter() - start) * 1000))
    return wrapper


def run_jev(session, engine_env):
    calls = {}
    session._decide = timed(calls, "decide_ms", session._decide)
    session._write = timed(calls, "write_ms", session._write)
    steps, outcome = [], "max_steps"
    start = time.perf_counter()
    for _ in range(MAX_STEPS):
        try:
            result = session.act({"fingerprint": session.page["fingerprint"], "intent": GOAL, "engine_env": engine_env})
        except bridge.BridgeError as error:
            if error.kind != "stale":
                raise
            steps.append({"operation": "STALE"})  # the plugin returns the new table; the next step decides again
            continue
        decision = result.get("decision") or {}
        steps.append({"operation": decision.get("operation"), "label": decision.get("label"),
                      "text": (result.get("generated_text") or {}).get("value")})
        if decision.get("operation") in {"DONE", "BLOCKED"}:
            outcome = decision["operation"].lower()
            break
    total = round((time.perf_counter() - start) * 1000)
    return {"elapsed_ms": total, "outcome": outcome, "actions": len([s for s in steps if s["operation"] not in {"DONE", "BLOCKED", "STALE"}]),
            "decisions": len(calls.get("decide_ms", [])), "model_ms": sum(calls.get("decide_ms", [])) + sum(calls.get("write_ms", [])),
            "decide_ms": calls.get("decide_ms", []), "write_ms": calls.get("write_ms", []), "steps": steps}


def respond(llm, effort, conversation):
    body = {"model": llm["model"], "instructions": SYSTEM, "input": conversation, "tools": TOOLS,
            "tool_choice": "auto", "parallel_tool_calls": False, "store": False}
    if effort:
        body["reasoning"] = {"effort": effort}
    request = urllib.request.Request(
        f"{llm['base']}/responses", data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {llm['key']}", "Content-Type": "application/json",
                 "User-Agent": "dsh-browser-use-bench/1", **llm["headers"]})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{llm['model']} HTTP {error.code}: {error.read()[:400]!r}") from None


def run_llm(session, llm, effort):
    observation = 1
    conversation = [{"role": "user", "content": f"Goal: {GOAL}\n\n{page_text(bridge.observation(session.page), observation)}"}]
    steps, latencies, usage, outcome = [], [], {"input_tokens": 0, "output_tokens": 0}, "max_steps"
    start = time.perf_counter()
    for _ in range(MAX_STEPS):
        began = time.perf_counter()
        reply = respond(llm, effort, conversation)
        latencies.append(round((time.perf_counter() - began) * 1000))
        for key in usage:
            usage[key] += (reply.get("usage") or {}).get(key, 0)
        calls = [item for item in reply.get("output", []) if item.get("type") == "function_call"]
        if not calls:
            outcome = "no_tool_call"
            break
        call = calls[0]
        conversation += [item for item in reply["output"] if item.get("type") in {"reasoning", "function_call"}
                         and (item.get("type") != "function_call" or item is call)]
        if call["name"] == "finish":
            steps.append({"operation": "DONE"})
            outcome = "done"
            break
        args = json.loads(call.get("arguments") or "{}")
        steps.append({"operation": args.get("operation"), "target": args.get("target"), "text": args.get("text")})
        try:
            result = session.act({"fingerprint": session.page["fingerprint"], **args})
            observation += 1
            output = page_text(result["page"], observation)
        except bridge.BridgeError as error:
            output = f"Refused ({error.kind}): {error}"
            if "page" in error.extra:
                observation += 1
                output += "\n" + page_text(error.extra["page"], observation)
        conversation.append({"type": "function_call_output", "call_id": call["call_id"], "output": output})
    total = round((time.perf_counter() - start) * 1000)
    return {"elapsed_ms": total, "outcome": outcome, "actions": len([s for s in steps if s["operation"] != "DONE"]),
            "decisions": len(latencies), "model_ms": sum(latencies), "decide_ms": latencies, "usage": usage, "steps": steps}


def one_run(session, profile, url, arm, engine_env, llm):
    """One fresh tab in the shared headless browser, as the plugin opens one per task."""
    session.open({"url": url, "mode": "launch", "headless": True, "userDataDir": profile})
    session.history = []
    for name in ("_decide", "_write"):
        session.__dict__.pop(name, None)
    result = run_jev(session, engine_env) if arm == "jev" else run_llm(session, llm, arm.split(":", 1)[1] or None)
    result["verified"], result["final"] = verified(session)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--effort", action="append", help="reasoning effort(s) for the llm arm, e.g. max, low")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    engine_env = {key: os.environ[key] for key in ENGINE_KEYS if os.environ.get(key)}
    for key in ("TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY"):
        if key not in engine_env:
            sys.exit(f"{key} is not set")
    llm = {"key": os.environ.get("LLM_API_KEY") or engine_env["TEXT_MODEL_API_KEY"],
           "base": (os.environ.get("LLM_BASE_URL") or engine_env.get("TEXT_MODEL_BASE_URL", "")).rstrip("/"),
           "model": os.environ.get("LLM_MODEL") or engine_env.get("TEXT_MODEL"),
           "headers": json.loads(os.environ.get("LLM_HEADERS") or engine_env.get("TEXT_MODEL_HEADERS") or "{}")}
    arms = ["jev"] + [f"llm:{effort}" for effort in (args.effort or ["max"])]
    server, url = serve_fixture()
    session, profile = bridge.Session(), tempfile.mkdtemp(prefix="dsh-bench-")
    runs, voided = [], []
    try:
        for index in range(args.runs):
            for arm in arms:  # alternate arms so drift in the network or the gateway hits all of them
                for attempt in range(3):
                    try:
                        result = {"arm": arm, "run": index + 1, **one_run(session, profile, url, arm, engine_env, llm)}
                        break
                    except (OSError, RuntimeError, bridge.BridgeError) as error:
                        # A transport or provider failure says nothing about speed: record it, redo the run.
                        voided.append({"arm": arm, "run": index + 1, "attempt": attempt + 1, "error": str(error)[:300]})
                        print(f"{arm:10} run {index + 1}: voided ({str(error)[:120]})", flush=True)
                else:
                    raise SystemExit(f"{arm} run {index + 1} failed three times")
                runs.append(result)
                print(f"{arm:10} run {index + 1}: {result['elapsed_ms'] / 1000:6.2f} s  {result['actions']} actions  "
                      f"{result['decisions']} decisions  outcome={result['outcome']}  verified={result['verified']}", flush=True)
                if not result["verified"]:
                    print(f"           final={result['final']} steps={result['steps']}", flush=True)
    finally:
        server.shutdown()
        try:
            session.shutdown({})
        except Exception:
            pass
    summary = {}
    for arm in arms:
        mine = [r for r in runs if r["arm"] == arm]
        decisions = [ms for r in mine for ms in r["decide_ms"]]
        summary[arm] = {"median_task_s": round(statistics.median(r["elapsed_ms"] for r in mine) / 1000, 2),
                        "median_decision_s": round(statistics.median(decisions) / 1000, 2) if decisions else None,
                        "verified": f"{sum(r['verified'] for r in mine)}/{len(mine)}"}
    print(json.dumps(summary, indent=2))
    if args.out:
        meta = {"goal": GOAL, "date": time.strftime("%Y-%m-%d"), "typesafe_model": engine_env.get("TYPESAFE_MODEL"),
                "text_model": engine_env.get("TEXT_MODEL"), "text_reasoning": engine_env.get("TEXT_MODEL_REASONING"),
                "llm_model": llm["model"], "headless": True}
        args.out.write_text(json.dumps({"meta": meta, "summary": summary, "runs": runs, "voided": voided}, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
