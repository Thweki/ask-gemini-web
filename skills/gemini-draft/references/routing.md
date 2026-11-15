# Routing

Policy: 2026-11-16. Local heuristic, no additional model calls or per-run benchmark requests.

| Task | Family preference (available only) | Thinking |
|---|---|---|
| quick: short factual questions, format conversion, rewrite/translate/extract | Flash-Lite → Hydrogen → Flash | low |
| writing: article/copy | Hydrogen → Argon → Carbon | medium |
| writing: fiction/poetry/story | Argon → Hydrogen → Carbon | medium |
| analysis: compare/report/evidence | Carbon → Hydrogen → Argon | high |
| coding: code/debug/algorithm | Carbon → Hydrogen → Argon | high |
| hard: proof/multi-step reasoning | Carbon → Hydrogen → Argon | high |

Classification reads the request before appended source materials; explicit `task` resolves ambiguity. Code keywords beat report/rewrite keywords. Remaining known families are fallbacks; unknown models use a unique current available choice with a warning. Never infer that an unfamiliar model is benchmarked.

Select model first, then discover its real thinking submenu. An unavailable automatic target uses the nearest supported level (ties prefer lower); explicit unsupported levels fail. xhigh is opt-in, not an automatic escalation. Plans/ledgers record actual choices, sources, policy date and warnings.

These preferences are engineering judgments informed by [scores](benchmarks.md), not benchmark guarantees. API levels and API latency do not prove Gemini web support or latency. Refresh evidence when explicitly requested or when new models invalidate the policy; do not refresh on every draft.
