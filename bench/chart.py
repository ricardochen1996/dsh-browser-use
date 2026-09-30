"""Draw docs/speed.<lang>.svg from bench/results.json, so every number in the README picture is measured.

  .venv/bin/python bench/chart.py            # writes docs/speed.en.svg and docs/speed.zh-CN.svg
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "bench" / "results.json"
data = json.loads(source.read_text())
summary, meta = data["summary"], data["meta"]
TEXT = {
    "zh-CN": {
        "jev": ("开启 jev", f"TypeSafe {meta['typesafe_model']} + {meta['text_model']}"),
        "llm:low": ("关闭 jev", f"{meta['llm_model']} · reasoning low"),
        "llm:max": ("关闭 jev", f"{meta['llm_model']} · reasoning max（DSH 当前配置）"),
        "title": "同一个任务，中位耗时",
        "task": "本地酒店搜索页 · 输入城市、勾两个筛选、搜索、打开结果 · 每组 {runs} 轮交替 · {date}",
        "stats": "每步决策中位 {decision:.1f} s · 校验通过 {verified}",
        "slower": " · 慢 {factor:.1f}×",
        "note": (
            "计时从页面打开后的第一次决策到 DONE / finish；"
            "这是决策循环对比，不含 DSH 委派与主会话往返。数据：bench/results.json"
        ),
    },
    "en": {
        "jev": ("Jev on", f"TypeSafe {meta['typesafe_model']} + {meta['text_model']}"),
        "llm:low": ("Jev off", f"{meta['llm_model']} · reasoning low"),
        "llm:max": ("Jev off", f"{meta['llm_model']} · reasoning max (current DSH setting)"),
        "title": "Same task, median time to done",
        "task": (
            "Local hotel search · type a city, tick two filters, search, open a result · "
            "{runs} alternating runs per arm · {date}"
        ),
        "stats": "median decision {decision:.1f} s · verified {verified}",
        "slower": " · {factor:.1f}× slower",
        "note": (
            "Clock: first decision after page open → DONE / finish. "
            "Decision-loop comparison; excludes DSH delegation and chat round-trips. Data: bench/results.json"
        ),
    },
}


def draw(lang):
    t = TEXT[lang]
    arms = [arm for arm in ("jev", "llm:low", "llm:max") if arm in summary]
    slowest = max(summary[arm]["median_task_s"] for arm in arms)
    fastest = summary["jev"]["median_task_s"]

    width, left, bar_max, row = 1280, 430, 450, 96
    height = 150 + row * len(arms) + 70
    font = "-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
        f'role="img" aria-label="Median task time with Jev on and off">',
        '<defs><linearGradient id="fast" x1="0" x2="1"><stop offset="0" stop-color="#f59e0b"/>'
        '<stop offset="1" stop-color="#fbbf24"/></linearGradient>'
        '<linearGradient id="slow" x1="0" x2="1"><stop offset="0" stop-color="#94a3b8"/>'
        '<stop offset="1" stop-color="#cbd5e1"/></linearGradient></defs>',
        f'<rect width="{width}" height="{height}" rx="20" fill="#0f172a"/>',
        f'<g font-family="{font}">',
        f'<text x="48" y="64" font-size="28" font-weight="800" fill="#f8fafc">{t["title"]}</text>',
        '<text x="48" y="96" font-size="15" fill="#94a3b8">'
        + t["task"].format(runs=len([r for r in data["runs"] if r["arm"] == "jev"]), date=meta["date"]) + '</text>',
    ]
    for position, arm in enumerate(arms):
        y = 140 + position * row
        stats = summary[arm]
        title, detail = t[arm]
        length = max(8, bar_max * stats["median_task_s"] / slowest)
        fill = "url(#fast)" if arm == "jev" else "url(#slow)"
        colour = "#fde68a" if arm == "jev" else "#e2e8f0"
        parts += [
            f'<text x="48" y="{y + 26}" font-size="20" font-weight="700" fill="{colour}">'
            f'{title}{" ⚡" if arm == "jev" else ""}</text>',
            f'<text x="48" y="{y + 50}" font-size="13" fill="#94a3b8">{detail}</text>',
            f'<rect x="{left}" y="{y + 6}" width="{length:.0f}" height="44" rx="10" fill="{fill}"/>',
            f'<text x="{left + length + 16:.0f}" y="{y + 36}" font-size="22" font-weight="800" fill="{colour}">'
            f'{stats["median_task_s"]:.1f} s</text>',
            f'<text x="{left + length + 16:.0f}" y="{y + 56}" font-size="12" fill="#94a3b8">'
            + t["stats"].format(decision=stats["median_decision_s"], verified=stats["verified"])
            + ("" if arm == "jev" else t["slower"].format(factor=stats["median_task_s"] / fastest)) + '</text>',
        ]
    parts += [
        f'<text x="48" y="{height - 30}" font-size="12" fill="#64748b">{t["note"]}</text>',
        '</g></svg>',
    ]
    target = ROOT / "docs" / f"speed.{lang}.svg"
    target.write_text("\n".join(parts) + "\n")
    print(f"wrote {target}")


for language in TEXT:
    draw(language)
