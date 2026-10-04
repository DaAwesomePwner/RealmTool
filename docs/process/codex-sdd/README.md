# How RealmTool work is executed: Codex agents through Orchestra

The user asked that implementation and review run on **Codex** agents (to save Claude usage), with **up to 3 Codex agents in parallel**, delegated through the **Orchestra** plugin (`orchestra@local`). Claude acts only as the controller. It writes plans and briefs, dispatches work, verifies, runs checks, rules on findings, merges and keeps the ledger.

This follows the `superpowers:subagent-driven-development` skill (task loop, fix rounds ≤ 5, a scoped re-review per fix round, and a final whole-branch review), with Orchestra as the dispatch mechanism.

## Orchestra in one screen

`orch` below means `bash "<orchestra>/scripts/orchestra.sh"`, where `<orchestra>` is `~/.claude/plugins/cache/local/orchestra/<version>`. Run it from the checkout Claude works in (the *target*, normally the phase branch). Each worker gets its own worktree at `<repo-parent>/.orchestra/RealmTool/<name>` on branch `orch/<name>`.

| Step | Command |
|---|---|
| Worktree | `orch create <name>`. Then add the `node_modules` junction (below) and write the brief to the printed `brief:` path, following Orchestra's `references/brief-template.md` (keep its Role block). Point the brief at the task text from the plan (`scripts/task-brief PLAN N` from the SDD skill) |
| Implement | `orch spawn <name> --agent codex --tier standard\|hard`, then a background `orch wait <name>` (Bash `run_in_background: true`, `timeout: 3000000`) |
| Verify | `orch diff <name>`, then run `npm run check` in the worker worktree yourself. A result from inside the sandbox doesn't count |
| Review | Optionally write `<name>.review.notes.md` (what you verified, the global constraints, the findings being fixed). Then `orch review <name> --agent codex --tier <same> --allow-same-family` and a background `orch wait <name>:review` |
| Fix | Write the confirmed findings to a file, `orch send <name> --file <it>`, wait, verify, then `orch review <name>` again (the same reviewer re-reviews its own findings) |
| Merge | Write `<name>.commit.md` (the plan's commit message + attribution), `orch commit <name>`, `orch merge <name>` (`--no-ff` into the phase branch; gated on an APPROVE for exactly that tree). Run `npm run check` on the phase branch |
| Clean up | Remove the junction, then `orch remove <name>` |

- **Same-family review is deliberate.** Orchestra defaults to cross-family review (Claude reviews Codex). The user's binding decision is Codex for review too, so always pass `--agent codex --allow-same-family` to `review`.
- **Tiers:** `standard` (Codex medium effort) for clear, local tasks; `hard` (Codex high effort) for cross-cutting, safety-critical or security work, and for the final whole-branch review. Use the same tier for a worker's reviewer.
- **Parallel workers must not edit the same files.** When two tasks append to a shared file (e.g. `plugins/index.ts`), merge one, then `orch rebase <name>` the other and re-review, or resolve the merge on the phase branch and run the check.
- **Final whole-branch review:** spawn a read-only reviewer with `orch spawn <name> --here --agent codex --tier hard` and a brief that points at the SDD review package (`scripts/review-package PLAN MERGE_BASE HEAD`). Fix its findings as Orchestra workers (one wave; split by disjoint files if that helps), each with a scoped re-review.

## Windows setup and gotchas

- **`spawn codex ENOENT`:** Orchestra's runtime can't start the npm `codex` shim. Export `ORCHESTRA_CODEX_BIN` in the same command as every `orch spawn`/`send`/`review`, pointing at the real binary, e.g. `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`.
- **`node_modules` junction:** the Codex sandbox has no npm registry access, so give each worker worktree a junction to the target's install: PowerShell `New-Item -ItemType Junction -Path <worktree>\node_modules -Target <target>\node_modules`. **Remove the junction before `orch remove`**, non-recursively (`[System.IO.Directory]::Delete(<path>, $false)`), or the removal deletes the shared install.
- **Vitest's default config loader can't start in the sandbox.** Briefs tell implementers to use `npx.cmd vitest run --configLoader native` and `npx.cmd tsc --noEmit` (`npx` may be blocked by PowerShell execution policy). Socket tests can also fail there with `EPERM`. The controller re-runs `npm run check` outside the sandbox.
- **Implementers never commit.** `orch commit` does. Commits use the repo's author identity; if git has no identity configured, set `GIT_AUTHOR_*`/`GIT_COMMITTER_*` for the command rather than changing git config.
- MSVC builds (`npm run build:helper`) do work inside Codex's sandbox. The built DLL is git-ignored, so new worktrees don't have one.
- **Leftover processes:** `orch remove` stops a worker's agents. If you also ran Codex through `codex-companion` (the pre-Orchestra method), it leaves broker trees (`app-server-broker.mjs` + `codex.exe app-server`) running. Kill only this repo's (check the broker's `--cwd`) whose parent process is dead. Other projects' brokers and the Codex desktop app aren't yours.

## Files here

- `implementer-contract.md`, `reviewer-contract.md`, `re-review-contract.md`: the Phase 2 contracts. Their rules (no git commands, TDD evidence, pristine test output, the review output format) belong in Orchestra briefs and review notes. Update the global-constraints block per phase.
- `mkdispatch.py`: the Phase 2 dispatch generator for direct `codex-companion` runs. Kept for reference only; Orchestra replaces it.

The SDD ledger is `.superpowers/sdd/<plan>/progress.md` (local, git-ignored); the handoff doc records its committed state.
