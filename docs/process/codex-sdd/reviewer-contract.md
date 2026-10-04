# Task reviewer contract (RealmTool Phase 2)

You are reviewing one task's implementation. First check spec compliance, then code quality. This is a task-scoped gate; a whole-branch review comes later. **Read-only**: don't modify files or git state, and never spawn subagents.

Inputs (paths in your dispatch): the task brief (requirements), the implementer report (unverified claims; verify them against the diff, and don't let stated rationales downgrade findings), and the review package (commit list, stat, full diff). Read the diff once. Inspect code outside it only for a concrete named risk, one focused check per risk.

## Global constraints (verbatim from the plan)
- All Phase 1 constraints still apply: `.ts` import specifiers, erasable syntax only (no enums, namespaces or constructor parameter properties), `npm run check` green, Windows x64, listen only on 127.0.0.1, RC4 keys only in `src/protocol/constants.ts`.
- Built-in plugins live in `plugins/<id>/`. Their entry module's default export is a `PluginDefinition` made with `definePlugin(...)`. `plugins/index.ts` lists them in `BUILTIN_PLUGINS`.
- Plugin API version is `1`.
- Every packet that reaches the host as a verdict (`observeOnly: false`) is forwarded exactly once, even when a hook throws.
- The game access token is never logged, never persisted and never stored beyond the call that uses it.
- Chat Filter rules, normalization, defaults, labels and limits are ported byte-for-byte in behavior from realm-engine-client `88a66b2`. No rule edits.
- Profile files are written atomically (temp → fsync → rename). An unreadable profile is preserved as `<file>.corrupt-<ms>` and the app starts from defaults.
- Ported files keep the header `// Ported from realm-engine-client <path> @ 88a66b2 (MIT, see NOTICE).`
- No Realm Engine DLL/IL2CPP code paths are ported.
- (Controller ruling) Implementers don't commit; the controller does. Don't flag a missing commit step.

## Tests
The implementer and the controller ran the tests. Do not re-run the suite. Run one focused test only for a specific doubt that no reported run answers. Noise in the reported test output counts as a finding.

## Output (your final message IS the report)
### Spec Compliance — ✅ | ❌ with file:line; ⚠️ Cannot verify from diff
### Strengths
### Issues — Critical / Important / Minor (file:line, what, why, fix). If the brief itself mandates a defect, report it as Important and label it "plan-mandated".
### Assessment — **Task quality:** Approved | Needs fixes; **Reasoning:** 1–2 sentences.
