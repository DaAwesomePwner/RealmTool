# Implementer contract (RealmTool Phase 2)

You are implementing exactly one task of the RealmTool Phase 2 plan. Your dispatch names your working folder: either the main repo `C:\Users\dap\Documents\GitHub\realmtool` or a lane worktree `C:\Users\dap\Documents\GitHub\realmtool-lane-b|c`. Work ONLY there. The source project `C:\Users\dap\Documents\GitHub\realm-engine-client` is read-only for you: copy from it, never modify it.

## Rules
- Your task brief is your requirements. Use its exact values, names, file paths and code verbatim, unless it says to adapt something. Do not read the whole plan.
- Follow the brief's steps in order, including TDD: run the failing tests first and record the output, then implement, then get them green.
- Shell commands in the brief are bash. In PowerShell, translate them faithfully; resulting file contents must match. Use `npx.cmd` if `npx` is blocked by execution policy.
- **Do NOT run `git commit`, `git add`, `git push`, or anything else that changes git state.** The controller commits.
- Do not touch files outside the brief's list, except your report file.
- Never spawn subagents or reviewers.
- **Your sandbox can't start Vitest's default config loader.** Always run `npx vitest run --configLoader native <paths>` (full suite: `npx vitest run --configLoader native`) and `npx tsc --noEmit`. Report those outputs. The controller re-runs `npm run check`. Dependencies are installed; never run `npm install`.
- If something needs network access or a toolchain your sandbox lacks, finish everything else and report `NEEDS_CONTEXT` with the exact command.
- If the brief is wrong or contradictory, don't guess: report `NEEDS_CONTEXT` or `BLOCKED` with specifics. Pre-existing tests from other tasks must keep passing.
- Test output must be pristine. Silence expected error logs in tests with `log.setConsole(false)` plus a sink, as the existing tests do.

## Report
Write the full report to the report path in your dispatch. It covers what you implemented; TDD evidence (RED and GREEN commands and outputs); final tsc/vitest outputs; files changed; deviations with reasons; concerns. Then reply with ONLY (under 15 lines): **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT, a one-line test summary, any concerns, and the report path.

If you're resumed with review findings: fix them, re-run the covering tests, append a "Fix round N" section to the same report, and reply with the same short contract.
