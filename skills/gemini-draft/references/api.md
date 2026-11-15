# API

## Bootstrap (agent only)

Needs Node.js 22.12+ and Chrome. In a source checkout, run `npm ci`, `npm run build`, then `npm run install:skill`; use `npm.cmd` on Windows if needed. The installer bundles the runtime and remembers the local profile. For an existing recognized installation use `npm run install:skill -- --update`; custom agent directories use `-- --destination <path>`. Keep human instructions to the natural-language request in the README; the agent performs setup through its normal host permissions.

## Call

Q&A uses the same `prompt` input as drafting; even a short answer is saved as Markdown. The goal is to shift the main generation to Gemini web, not promise zero agent-plan usage. Antigravity app availability and Gemini web eligibility are separate checks: [Antigravity FAQ](https://antigravity.google/docs/faq), [Gemini web availability](https://support.google.com/gemini/answer/13575153?hl=en). No region list is hardcoded.

`run <job.yaml>` or `run --stdin` (JSON); returns compact `{id,state,result,selection}`.

| Input | Default |
|---|---|
| `prompt` / `promptFile` | Exactly one; UTF-8 |
| `model`, `thinking` | `auto`; explicit choices never silently change |
| `task` | `auto`, or quick/writing/analysis/coding/hard |
| `variables`, `materials` | `{}`, `[]`; text files, paths relative to job |
| `timeoutSeconds`, `output` | 600; saved in task directory, optional extra export |

Thinking accepts live labels or minimal/low/medium/high/xhigh; `mid` aliases medium. Only levels actually offered by the selected web model can be applied.

JSON stdin and JSON job files accept an initial UTF-8 BOM. The runner returns a nonzero exit code and a JSON object with `error.code` on invalid input. Use `INVALID_JSON` or `INVALID_YAML` for syntax errors, `INVALID_JOB` for schema errors, `INVALID_UTF8` for invalid stdin bytes and `INVALID_ARGUMENT` for CLI usage errors.

Variable names allow Unicode letters, marks and numbers plus underscores, dots and hyphens. Substitution runs once on the prompt. A backslash before a placeholder preserves its literal braces. In JSON write `"\\{{name}}"` to submit `{{name}}`. Unknown unescaped variables return `MISSING_VARIABLE`.

`plan <job>` or `plan --stdin` (JSON) previews live routing and restores prior model/level; no submission. `run --dry-run` only renders inputs, offline. `models list`, `thinking list`, `thinking select <level>` inspect/control live settings. `status <id>` reads the full ledger; `resume <id>` never resends attempted submissions. `export <id> --output <path>` never overwrites.

`ready` is optional diagnostics. On auth errors, `login` opens a persistent dedicated Chrome; human handles Google sign-in/verification. On sandbox/CDP permission errors request the host's normal narrow execution permission. `MODEL_UNAVAILABLE`/`THINKING_UNAVAILABLE` require a changed explicit request; uncertain submission requires original-conversation recovery.
