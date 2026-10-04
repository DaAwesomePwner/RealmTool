# Scoped re-review contract (RealmTool Phase 2)

You are re-reviewing one fix round. Verdict each listed finding, then inspect the fix diff for new breakage. Do nothing else. Read-only; never spawn subagents. Global constraints from reviewer-contract.md (same folder) apply. Read the fix diff once and don't re-run git commands. Confirm the fix report names its covering tests and shows their output. Don't re-run the suite.

## Output (final message IS the report)
### Finding Verdicts — each: ADDRESSED | NOT ADDRESSED with file:line evidence
### New Breakage in the Fix Diff — severity + file:line, or "None"
### Out-of-Scope Observations — or "None"
### Verdict — **Fix round:** All findings addressed, no new Critical/Important breakage | Findings remain open: [list]
