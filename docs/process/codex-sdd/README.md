# How RealmTool work is executed: Codex subagent-driven development

The user asked that implementation and review run on **Codex** agents (to save Claude usage), with **up to 3 Codex agents in parallel**. Claude acts only as the controller. It writes plans and briefs, dispatches work, commits, runs checks, rules on findings and keeps the ledger.

This follows the `superpowers:subagent-driven-development` skill (task loop, fix rounds ≤ 5, a scoped re-review per fix round, and a final whole-branch review), adapted to Codex.

## Dispatching Codex directly (not via the `codex:codex-rescue` agent)

```bash
C=~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs
# implementer (can write inside its cwd only):
cd <working folder> && node "$C" task --write --fresh --prompt-file <dispatch.md>
# reviewer (read-only):
cd <repo> && node "$C" task --fresh --prompt-file <review-dispatch.md>
```

- Run it with the Bash tool's `run_in_background: true` so you're notified on completion. Don't background with `&` inside a command that then exits, or you lose the notification (a watcher loop `until [ -s out ]; do sleep 10; done` works around it).
- `--effort high` for the final whole-branch review.
- Codex's working directory is its sandbox: it can only **write inside its cwd**, and it can read elsewhere. Lane workers write reports inside their worktree (`<worktree>/.superpowers/sdd/`, git-ignored), and the controller copies them.

## Codex sandbox gotchas (Windows)

- **No npm registry access.** The controller runs `npm install`. koffi's install script is approved in `package.json` `allowScripts`.
- **Vitest's default config loader can't start in the sandbox.** Implementers must use `npx vitest run --configLoader native`. The controller re-runs `npm run check` outside the sandbox.
- `npx` may be blocked by PowerShell execution policy, so use `npx.cmd`.
- **Implementers never commit.** The controller commits each task with the plan's message, then generates the review package (`scripts/review-package` from the skill, or `git log/diff` into a file for lane worktrees).
- MSVC builds (`npm run build:helper`) do work inside Codex's sandbox.
- **Process leak:** each Codex run leaves its MCP servers and `codex.exe` running under a broker daemon (`app-server-broker.mjs`). Periodically kill orphaned broker trees for this repo whose parent process is dead. Other projects' brokers aren't yours; leave them alone.

## Parallel lanes

Independent tasks run in git worktrees next to the repo (`../realmtool-lane-b`, `../realmtool-lane-c`) on their own branches:
- give each worktree a `node_modules` **junction** to the main repo's (PowerShell `New-Item -ItemType Junction`);
- give each a git-ignored `.superpowers/sdd/.gitignore` containing `*`.

After review, the controller cherry-picks lane commits onto the phase branch.

**Before removing a worktree, remove its `node_modules` junction first** (`cmd /c rmdir <path>`). Otherwise the removal deletes the shared install.

## Files here

- `implementer-contract.md`, `reviewer-contract.md`, `re-review-contract.md`: the Phase 2 contracts. Update the global-constraints block per phase.
- `mkdispatch.py`: the dispatch-file generator used in Phase 2. Paths are hard-coded for the original machine; adjust `W`/`ROOT`.

The per-task briefs come from the plan via the skill's `scripts/task-brief PLAN N`. The ledger is `.superpowers/sdd/<plan>/progress.md` (local, git-ignored); see the handoff doc for its committed state.
