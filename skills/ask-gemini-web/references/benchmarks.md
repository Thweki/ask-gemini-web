# Benchmark snapshot

Checked 2026-11-16; Arena pages dated 2026-11-11. Scores are not comparable across columns. `—` means omitted/unverified, not zero.

| Gemini variant | AA Intelligence | Text Arena | WebDev Arena |
|---|---:|---:|---:|
| 4 Carbon high | 60 | 1526 ±10 (preliminary) | 1768 ±15 (preliminary) |
| 4 Argon high | 50 | 1522 ±5 | 1681 ±10 |
| 4 Hydrogen high | 51 | 1490 ±9 (preliminary) | 1704 ±14 (preliminary) |
| 3.1 Pro Preview | — | 1487 ±3 | — |
| 3.5 Flash-Lite | 12 | 1455 ±5 | — |

Sources: [AA](https://artificialanalysis.ai/embed/llm-performance-leaderboard), [Text Arena](https://arena.ai/leaderboard/chat/text), [WebDev Arena](https://arena.ai/leaderboard/code/webdev).

AA also reports Hydrogen medium/high/xhigh intelligence 41/51/54 and benchmark time per task 3.8/8.4/14.8 minutes; Argon medium reports 28.5 minutes. These are API benchmark measurements, not expected web drafting times. Text Arena is preference-based; WebDev measures web development, not all programming. Preliminary intervals overlap; do not treat point scores as definitive wins.

Inference: prefer Hydrogen medium for ordinary prose, Argon medium for explicit literary creation, Carbon high for difficult analysis/code when accessible, Flash-Lite low for simple transformations. Medium prose routing balances effort and latency; the high-score rows do not measure medium. In this web acceptance an Argon medium short draft exceeded 180 seconds without body text; that single observation supports a responsive default, not a general speed claim.

[Google thinking guidance](https://aistudio.google.com/docs/thinking) recommends matching effort to complexity and reserving xhigh for hard tasks. Web menus are authoritative: this account exposed low/medium/high, while API options vary by model. Never map an API capability to the website without observing it.
