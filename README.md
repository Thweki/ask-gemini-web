# ask-gemini-web

[English](README.md) | [简体中文](README.zh-CN.md) · [MIT](LICENSE)

Let your agent ask questions or draft text through your Gemini web account. The skill selects a model and thinking level for the task and saves the result as Markdown.

Built for web Q&A and drafting that preserve your agent-plan quota by moving the main generation to Gemini web. Also for users whose region does not support the Antigravity app but who can access Gemini web. Gemini web's own eligibility and usage limits still apply; agent coordination may use some agent quota.

## For humans

Pass this repository link or local folder to your agent and say:

> Set up ask-gemini-web and use my Gemini web account to write an article about urban gardens; choose the model and thinking level for the task, and ask me to sign in only when needed.

Your agent handles setup and execution. You sign in directly at Google inside a dedicated Chrome window. Login persists in a local profile across restarts, though Google may occasionally require verification. No API key is needed; standard Gemini web usage limits apply.

## For agents

Load [SKILL.md](skills/ask-gemini-web/SKILL.md), resolve the bundled runner, and make one call with JSON on stdin:

```text
node <skill>/scripts/gemini-draft.mjs run --stdin
```

```json
{"prompt":"Write a short article about urban gardens."}
```

```text
draft({ prompt, model?, thinking?, task? }) → { id, state, result, selection }
```

Omitted options use local task routing against live web capabilities. Explicit parameters take priority and fail if unavailable (e.g., `"model":"Gemini 4 Hydrogen","thinking":"medium"` pins both). Browser startup, selection, submission, and saving run inside this single call without an extra model-driven browser loop.

Load references only as needed: [setup/API/recovery](skills/ask-gemini-web/references/api.md), [routing policy](skills/ask-gemini-web/references/routing.md), or [dated benchmark evidence](skills/ask-gemini-web/references/benchmarks.md). Do not prepend diagnostic calls to ordinary drafting. Preview with `plan`; recover uncertain submissions with `resume <id>`, never a new run. Follow the host's normal permission flow for local Chrome/CDP access.

Requires Node.js 22.12+, Chrome, and Gemini access. The installer provides independent runtimes for Codex and Agent Skills directories. Profiles and saved task records stay local and are excluded from release packages—never export passwords or cookies.

Supports standard single-turn text and basic Markdown. Canvas, Deep Research workflows, binary uploads, and exact regeneration are outside this version. Verified on Windows, Chrome 157, and Chinese Gemini UI; other environments may need adapter updates. See [acceptance](ACCEPTANCE.md). Licensed under [MIT](LICENSE).
