# API

## Bootstrap (agent only)

Needs Node.js 22.12+ and Chrome. In a source checkout, run `npm ci`, `npm run build`, then `npm run install:skill`; use `npm.cmd` on Windows if needed. The installer bundles the runtime and remembers the local profile. For an existing recognized installation use `npm run install:skill -- --update`; custom agent directories use `-- --destination <path>`. Keep human instructions to the natural-language request in the README; the agent performs setup through its normal host permissions.

The installer saves `endpoint` with `explicitCdp: true` in `<skill>/connection.json` only for an install-time `--cdp` or CDP environment variable. The runner forwards that marked endpoint as `--cdp`; user command-line options still win. An old unmarked endpoint is forwarded as an implicit `--remembered-cdp` hint and tried first; if unreachable, discovery and launch continue. Other new installs save only `home`, so startup reads the home's remembered endpoint and can discover or launch. Updates preserve marked explicit choices and treat older unmarked `{ home, endpoint }` connections as implicit. To unpin an installation, remove `explicitCdp` from the skill's connection file and clear any CDP command-line options/environment variables.

## Call

The skill and CLI were previously named `gemini-draft`. On a default-path upgrade, `--update` installs `ask-gemini-web` alongside the previous skill and reuses its connection settings. Existing CLI commands and saved job IDs still work.

Q&A uses the same `prompt` input as drafting; even a short answer is saved as Markdown. The goal is to shift the main generation to Gemini web, not promise zero agent-plan usage. Antigravity app availability and Gemini web eligibility are separate checks: [Antigravity FAQ](https://antigravity.google/docs/faq), [Gemini web availability](https://support.google.com/gemini/answer/13575153?hl=en). No region list is hardcoded.

`run <job.json>` / `run <job.yaml>` or `run --stdin` (JSON); returns compact `{id,state,promptSha256,result,selection}`. Prefer a UTF-8 file on Windows to bypass PowerShell pipe encoding. For example in PowerShell:

```powershell
[IO.File]::WriteAllText((Join-Path (Get-Location) 'job.json'), '{"prompt":"请写一篇关于青竹的短文。"}', [Text.UTF8Encoding]::new($false))
node <skill>/scripts/ask-gemini-web.mjs run job.json
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

An explicit CDP address (`--cdp`, `ASK_GEMINI_WEB_CDP`, or the legacy `GEMINI_DRAFT_CDP` fallback) selects only that browser. If unreachable, it fails with `CDP_UNAVAILABLE` (exit 2) without discovery, launch, or changes to `connection.json`: start Chrome at that address, or remove the option/environment variable to use auto-discovery. Implicit discovery tries the remembered/configured endpoint → common local ports 9222 and 9333 → Chrome/Chromium process command-line hints (Linux/macOS/Windows) → `DevToolsActivePort` files in known and dedicated profile locations → local Chrome/Chromium-owned listening TCP ports (Linux `/proc`, no `ss` dependency) → launch with the dedicated profile. The initial endpoint is selected by precedence: `--remembered-cdp` → the selected home's `connection.json` → project `ask-gemini-web.config.json` / `gemini-draft.config.json` `cdp` → default `http://127.0.0.1:9222`. Legacy skill `connection.json` files containing `{ home, endpoint }` without `explicitCdp` supply `--remembered-cdp` as the first implicit candidate; an unreachable endpoint allows discovery to continue. Linux process hints accept both NUL-separated argv and Chrome’s space-joined cmdline. Only local HTTP endpoints are accepted; duplicate and invalid discovered addresses are skipped.

The first reachable browser is retained, including when signed out: `AUTH_LOGGED_OUT` (exit 3) reports the endpoint; run `ask-gemini-web login` and sign in manually at Google in that same browser. There is no silent replacement with a fresh profile. An existing signed-in agent browser is reused through a **new tab**; existing tabs are never focused or navigated. Chrome stays running after disconnect. Jobs with saved results (including pending exports) and failures known to precede sending close their task tabs; uncertain submissions and incomplete collection retain the original tab for `resume`. `google.com/sorry` or unusual-traffic / 可疑流量 / 异常流量 copy on Google pages returns `AUTH_BLOCKED_SORRY` (exit 3); complete verification manually in that browser or use an already signed-in browser. The tool keeps the blocked tab open and never attempts to solve or click through CAPTCHA. Login timeout and `login --no-wait` retain the new tab for manual sign-in. With an implicit CDP address, a dedicated `chrome-profile` browser is launched only when no CDP browser is reachable; a busy configured port uses a free loopback port, saved in `connection.json` with mode 0600. Credentials, cookies and profiles are never copied or exported. Follow the host's normal local-browser permission flow.

The canonical command and runner are `ask-gemini-web` and `scripts/ask-gemini-web.mjs`. The deprecated `gemini-draft` command and runner still forward to them. Configuration uses `ask-gemini-web.config.json`; `gemini-draft.config.json` is read only when the new file is absent. Environment variables are `ASK_GEMINI_WEB_CDP`, `ASK_GEMINI_WEB_HOME`, and `ASK_GEMINI_WEB_CHROME` (runner runtime override: `ASK_GEMINI_WEB_APP`); corresponding `GEMINI_DRAFT_*` variables remain fallbacks only when the new variable is unset. Deprecated names emit notes on stderr, including with `--json`/`--compact`; stdout stays machine-readable.

Home precedence is `--home` → new/legacy home environment variable → project `home` → existing project `.ask-gemini-web` → existing platform home → existing legacy project `.gemini-draft` or platform home → new platform default. Platform defaults are `~/.local/share/ask-gemini-web` or `%LOCALAPPDATA%\ask-gemini-web` (user home if LOCALAPPDATA is absent). Legacy homes use the same paths with `gemini-draft`. If an implicit project `home` names a missing `.ask-gemini-web` or `ask-gemini-web` directory, an existing sibling `.gemini-draft` or `gemini-draft` is reused with a deprecation note. Explicit CLI/environment home paths always win. The selected home's `connection.json`, `chrome-profile`, and saved runs are reused in place; profiles are never copied or migrated. CDP precedence is CLI `--cdp` → new/legacy CDP environment → `--remembered-cdp` → selected home's `connection.json` → project `cdp` → default.
