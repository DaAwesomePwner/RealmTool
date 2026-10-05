# Phase 4 handoff — Anti-AFK (off until enabled)

Plan: `docs/superpowers/plans/2026-10-05-phase4-anti-afk.md`.

## AFK findings that shaped it (live, 2026-10-05)

- **The kick is client-side, at about 20 minutes without input.** An idle session closed 20 m 49 s after the last move with no `FAILURE` and no warning notification before it. A server-side close (for example a restart) always shows a `FAILURE` right before `closed by game`.
- **A posted left click resets the timer, even with the game in the background.** `WM_LBUTTONDOWN` (`MK_LBUTTON`), 32 ms, `WM_LBUTTONUP` to the `UnityWndClass` window kept a session alive for 35+ minutes with a click every 5 minutes.
- **The game aims at the real cursor.** The click's `lParam` is ignored, so the shot goes toward wherever the cursor actually is.
- **A posted F15 key press does not reset the timer.** That session closed 20 m 1 s after the last real input, despite four F15 presses.

## What shipped

| Piece | Outcome |
|---|---|
| `src/input/gameInput.ts` | `pulseGameWindow`: a cursor guard (P4-2), then a down/up click pair; the button-up is always sent. The click is allowed only when the cursor is outside the client rect or inside the central 50% × 50% safe box. |
| `src/input/win32GameInput.ts` | koffi `user32` bindings. Finds exactly one visible `UnityWndClass` window owned by the game PID and reads its client rect, minimized state and cursor; `PostMessageW`. No injection and no helper-DLL change. |
| `input` capability | `ctx.input.pulse(client)`. The game process is identified from the TCP owner of the client's remote port (PID + creation time) and bound per session, so a different process returns `process-changed`. The win32 source loads lazily and warns once if it's unavailable. |
| `anti-afk` built-in (sixth) | **Off until enabled.** One setting, `idleMinutes` (1–15, default 5). Idle means no position change, shot, item use, chat or inventory swap; a MOVE gap over 10 s or a map change restarts the window. Logs `Inactive for N min; click sent.` or `Pulse skipped: <reason>.` (once per reason per session). Status updates at most once per second. |

## Validation

- `npm run check` passes (**1480 tests, 77 files**). Each task got an independent Codex review; the coordinator fixed two issues: a stray `input` capability in a design.md example, and a status publish on every packet.
- Package smoke passed on the port-busy path, because the user's installed RealmTool holds port 2050.
- **Live acceptance (user, 2026-10-05), idleMinutes = 1, game in the background:**
  - The character shot when the cursor was in the safe box or off the game: `Inactive for 1 min; click sent.` at 20:41:58 and 20:48:59.
  - With the cursor over the game UI there was no shot and `Pulse skipped: cursor-over-game-ui.` was logged (20:39:57).
  - The session ended at 15 m 47 s, before the 20-minute limit, so this run doesn't show the disconnect being prevented. The earlier manual click test (35+ minutes connected) already shows that.

## Not yet verified live

- A minimized game window (P4-4). The click is posted anyway and the status reports `minimized`.
- A full 30+ minute idle session with the plugin itself at the default 5 minutes.

## Follow-up: cursor parked over the game UI (user request)

**Problem.** Every attempt consumes the idle window, including a skipped one (`detector.ts`: "Consume even a skipped pulse"). At 5 minutes, a cursor left over the inventory, minimap or chat gets attempts at about 5, 10 and 15 minutes, all skipped, and the client disconnects at about 20. Only the first skip is logged, so the log shows nothing as the kick approaches.

**Options, in the recommended order:**

1. **Retry sooner and warn (cheap, no new input).**
   - After a `cursor-over-game-ui` skip, retry every 15 s instead of waiting another full window, so the click lands as soon as the cursor passes the safe box.
   - Count consecutive skips in the status, and log once when the client reaches 15 minutes without input of any kind ("could not click: cursor over the game UI; Exalt disconnects at about 20 minutes").
   - Optionally add a tray notification for that warning.
2. **Click a chosen spot while the user is away from the PC.**
   - Only when `GetLastInputInfo` shows no keyboard or mouse input system-wide for several minutes, so the user can't be mid-drag in another app.
   - Then `SetCursorPos` to the centre of the safe box, post the click, and put the cursor back exactly where it was.
   - Live checks needed:
     - the game reads the cursor at click time when it's in the background, so the shot follows the moved cursor;
     - `SetCursorPos` fails harmlessly on a locked workstation or the secure desktop, and whether the game idles out while locked at all.
   - This fully covers the failure case, because "cursor over the UI and nobody touching the PC" is exactly when moving the cursor is safe.
3. **A non-aiming input.** Test a posted key that the game actually binds, such as a movement tap (the unbound F15 failed). Low confidence: posted keys may not reach Unity's input at all.

Rejected: aiming through the injected helper DLL (hooking cursor reads in-process). It's far more invasive than out-of-process window messages, which is what Phase 4 deliberately avoids.
