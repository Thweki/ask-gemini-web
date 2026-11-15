# API

## Bootstrap (agent only)

Needs Node.js 22.12+ and Chrome. In a source checkout, run `npm ci`, `npm run build`, then `npm run install:skill`; use `npm.cmd` on Windows if needed. The installer bundles the runtime and remembers the local profile. For an existing recognized installation use `npm run install:skill -- --update`; custom agent directories use `-- --destination <path>`. Keep human instructions to the natural-language request in the README; the agent performs setup through its normal host permissions.

## Call

The skill was previously named `gemini-draft`. On a default-path upgrade, `--update` installs `ask-gemini-web` alongside the previous skill and reuses its connection settings. Existing CLI commands and saved job IDs still work.

Q&A uses the same `prompt` input as drafting; even a short answer is saved as Markdown. The goal is to shift the main generation to Gemini web, not promise zero agent-plan usage. Antigravity app availability and Gemini web eligibility are separate checks: [Antigravity FAQ](https://antigravity.google/docs/faq), [Gemini web availability](https://support.google.com/gemini/answer/13575153?hl=en). No region list is hardcoded.

`run <job.json>` / `run <job.yaml>` or `run --stdin` (JSON); returns compact `{id,state,promptSha256,result,selection}`. Prefer a UTF-8 file on Windows to bypass PowerShell pipe encoding. For example in PowerShell:

```powershell
[IO.File]::WriteAllText((Join-Path (Get-Location) 'job.json'), '{"prompt":"请写一篇关于青竹的短文。"}', [Text.UTF8Encoding]::new($false))
node <skill>/scripts/gemini-draft.mjs run job.json
```

The full 64-character `promptSha256` hashes the rendered prompt, including substituted variables and appended materials, not the JSON file bytes. `run <job.json> --dry-run` reports the same field without using Gemini. ASCII replacement already performed by a shell remains valid UTF-8 and cannot be recovered or reliably detected by the runner.

`--compact` and `--json` suppress progress on stderr and report failures as JSON on stdout with a nonzero exit code. `--quiet` suppresses progress in the human-readable mode while retaining stderr errors.

| Input | Default |
|---|---|
| `prompt` / `promptFile` | Exactly one; UTF-8 |
| `model`, `thinking` | `auto`; explicit choices never silently change |
| `task` | `auto`, or quick/writing/analysis/coding/hard |
| `variables`, `materials` | `{}`, `[]`; text files, paths relative to job |
| `timeoutSeconds`, `output` | 600; saved in task directory, optional extra export |

Thinking accepts minimal/low/medium/high/xhigh; `mid` and `Standard` alias medium, `Extended` aliases high. UI names and descriptions must normalize to one of those IDs; unknown or ambiguous levels fail closed. Only levels actually offered by the selected web model can be applied.

`models list` returns the actual model text in `name`, a stable ID derived from that text, and the localized use-case label in optional `mode`. `current` is one model name. Selection summaries use `model` for the model name and `mode` for its localized label.

JSON stdin and JSON job files accept an initial UTF-8 BOM. The runner returns a nonzero exit code and a JSON object with `error.code` on invalid input. Use `INVALID_JSON` or `INVALID_YAML` for syntax errors, `INVALID_JOB` for schema errors, `INVALID_UTF8` for invalid task/prompt/material bytes and `INVALID_ARGUMENT` for CLI usage errors.

Variable names allow Unicode letters, marks and numbers plus underscores, dots and hyphens. Substitution runs once on the prompt. A backslash before a placeholder preserves its literal braces. In JSON write `"\\{{name}}"` to submit `{{name}}`. Unknown unescaped variables return `MISSING_VARIABLE`.

`plan <job>` or `plan --stdin` (JSON) previews live routing and restores prior model/level; no submission. `run --dry-run` only renders inputs, offline. `models list`, `thinking list`, `thinking select <level>` inspect/control live settings. `status <id>` reads the full ledger; `resume <id>` never resends attempted submissions. `export <id> --output <path>` never overwrites.

`collected` means the local response is saved but the requested extra output is pending. Fix the output path or remove a conflicting file, then `resume <id>` retries the export locally without Chrome or another submission. `complete` means the requested output was published too. Publication stages a complete file beside the destination and uses a hard link to avoid overwrites; filesystems without hard-link support fail and retain the collected result for manual export.

`ready` is optional diagnostics. On auth errors, `login` opens a new tab in the selected persistent Chrome; human handles Google sign-in/verification. On sandbox/CDP permission errors request the host's normal narrow execution permission. `MODEL_UNAVAILABLE`/`THINKING_UNAVAILABLE` require a changed explicit request; uncertain submission requires original-conversation recovery.

Browser discovery first probes the configured CDP address (`--cdp` → `GEMINI_DRAFT_CDP` → the selected home's `connection.json` → project `gemini-draft.config.json` `cdp`, default `http://127.0.0.1:9222`), then common local ports 9222 and 9333, then running Chrome/Chromium process hints and `DevToolsActivePort` files in known profile locations and the dedicated profile. Only local HTTP endpoints are accepted; duplicate and invalid discovered addresses are skipped. An unreachable configured endpoint allows discovery to continue.

The first reachable browser is retained, including when signed out: `AUTH_LOGGED_OUT` (exit 3) reports the endpoint; run `gemini-draft login` and sign in manually at Google in that same browser. There is no silent replacement with a fresh profile. An existing signed-in agent browser is reused through a **new tab**; existing tabs are never focused or navigated. Disconnect closes this session's tabs and leaves Chrome running. `login --no-wait` deliberately leaves its new tab open for manual sign-in. A dedicated `chrome-profile` browser is launched only when no CDP browser is reachable; a busy configured port uses a free loopback port, saved in `connection.json` with mode 0600. Credentials, cookies and profiles are never copied or exported. Follow the host's normal local-browser permission flow.
