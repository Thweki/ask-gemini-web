---
name: ask-gemini-web
description: Ask questions or draft text through the user's Gemini web account. Automatically select a model and thinking level and return the saved Markdown result.
---

# Ask Gemini Web

Offload Q&A and drafting to the user's Gemini web allowance to reduce work charged to the calling agent's plan. Also serve users whose region does not support the Antigravity app but who can use Gemini web. This uses Gemini web's own quota and eligibility; agent orchestration and result handling may still consume some agent quota.

`draft({prompt, model?, thinking?, task?}) → {id, result, selection}`

Run once; send JSON on stdin. Resolve the runner relative to this skill:

```text
node <skill>/scripts/gemini-draft.mjs run --stdin
```

Example input: `{"prompt":"Write an article about urban gardens."}`. The CLI reuses login, discovers live capabilities, chooses model + thinking, submits and saves. Do not add separate readiness or model-list calls to ordinary drafting.

For a template, send `{"prompt":"介绍{{城市}}","variables":{"城市":"杭州"}}`. To discuss a literal placeholder, send `{"prompt":"解释 \\{{name}} 的含义"}`.

User overrides win; otherwise routing is local and deterministic. Return the saved `result` and actual selection. Never substitute an unavailable explicit choice. Use `resume <id>` for recovery. It can submit a prepared job after a pre-click failure and only reads the original conversation after a possible send.

Load only when needed:
- [API](references/api.md): optional inputs, preview, recovery, login/errors.
- [Routing](references/routing.md): inspect or explain automatic decisions.
- [Benchmarks](references/benchmarks.md): dated scores, evidence, policy refresh.

On login errors run `login`; the user signs in directly at Google. Profile state persists across restarts. Use the host's normal permission flow for local Chrome/CDP; never export credentials. No Canvas, attachment upload or Deep Research tool workflow in this version.
