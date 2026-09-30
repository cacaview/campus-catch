# Authoritative Online Room Lobby Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep online room participants in a live waiting lobby until the host starts, then synchronize the start across clients.

**Architecture:** The relay owns room phase and host authority. The existing lobby view gains a server-room mode while preserving its offline AI mode; the game view only starts for a server room after a relay start event.

**Tech Stack:** Native browser ES modules, Node.js ESM, `node:test`, existing WebSocket relay.

**Spec:** `docs/superpowers/specs/2026-09-29-web-online-features-design.md`, section 8.

## Global Constraints

- Change only the Web project; do not edit the mini-program source tree.
- Keep existing chat and WebRTC voice behavior available in the game view.
- The relay is authoritative for room phase, host identity, and start requests.
- A room has `WAITING` and `STARTED` phases; relay restart discards room state.
- New participants cannot join a `STARTED` room; known room participants may reconnect.
- Keep the offline AI lobby and offline countdown behavior unchanged.

## Review Focus

1. Duplicate or malicious `ROOM_START_REQUEST` packets must not start a room twice or start a room as a guest. Pin in Task 1's `onlyHostCanStartAfterAnotherPlayerJoins` test.
2. A started room must reject unknown late joiners but permit known clients to reconnect. Pin in Task 1's `rejectsLateJoinButAllowsKnownPlayerReconnect` test.
3. Waiting-room host disconnect must leave a usable room and update the promoted host consistently. Pin in Task 1's `promotesNextMemberWhenWaitingHostDisconnects` test.
4. Navigating directly to the game route before the relay start event must not start an online game. Pin in Task 3's regression test and browser checklist.
5. A relay disconnect during a pending lobby start must not route a client into the game. Pin in Task 2/3 network and checklist coverage.

---

### Task 1: Authoritative relay room lifecycle

**Files:**
- Modify: `server/lib/room-registry.js`
- Test: `server/test/room-registry.test.js`

**Interfaces:**
- Consumes: existing `JOIN_ROOM`, `JOIN_ACK`, room membership, and `RoomRegistry` packet routing.
- Produces: `ROOM_START_REQUEST`, `ROOM_STARTED`, `ROOM_START_ERROR`, and `ROOM_HOST_CHANGED` messages; successful `JOIN_ACK` includes `phase`, `hostId`, `isHost`, `startAt`, and members with host flags.

- [x] **Step 1: Write failing registry tests** named `assignsFirstMemberAsHostAndReturnsWaitingPhase`, `onlyHostCanStartAfterAnotherPlayerJoins`, `rejectsLateJoinButAllowsKnownPlayerReconnect`, and `promotesNextMemberWhenWaitingHostDisconnects`. Assert that host-only start with fewer than two connected members is rejected; valid start changes phase once and broadcasts one `ROOM_STARTED` with `startAt` in the future.
- [x] **Step 2: Run the focused tests and confirm the expected missing lifecycle behavior.**

Run: `cd server && node --test test/room-registry.test.js`

Expected: the new tests fail because the registry has no host or room phase lifecycle.
- [x] **Step 3: Implement the relay state transitions.** First joined player is host; room starts in `WAITING`; server validates start authority and membership count; start is idempotent; unknown late joiners receive a failed `JOIN_ACK`; previously joined player IDs can reconnect; a waiting room promotes the earliest remaining member after host disconnect.
- [x] **Step 4: Run relay tests and review output.**

Run: `cd server && node --test test/*.test.js`

Expected: all relay, chat, voice, room-phase, host-transfer, and TURN tests pass.

### Task 2: Client room session and event propagation

**Files:**
- Modify: `js/utils/network/protocol.js`
- Modify: `js/utils/network/room-session.js`
- Modify: `js/utils/network/network-manager.js`
- Test: `test/network.test.js`

**Interfaces:**
- Consumes: Task 1's room lifecycle packets.
- Produces: `roomSession.phase`, `hostId`, `startAt`, live `members`; `joinSuccess` receives relay host/phase state; `ROOM_STARTED` and `ROOM_HOST_CHANGED` update `roomSession` before listeners run.

- [x] **Step 1: Add failing network tests** for authoritative join state, live member add/remove, host transfer, started-state propagation, emitting `ROOM_START_REQUEST` through `NetworkManager.send`, and automatic reconnect preserving room code/settings.
- [x] **Step 2: Run the focused network tests and confirm expected missing state/events.**

Run: `node --test test/network.test.js`

Expected: failures for the new message types and state propagation.
- [x] **Step 3: Add protocol constants and update `RoomSession` from relay events.** Do not trust locally guessed `isHost` after `JOIN_ACK`; replace it with the relay response. Keep existing host/client setup until that acknowledgment arrives.
- [x] **Step 4: Run the focused and existing network tests.**

Run: `node --test test/network.test.js`

Expected: all network lifecycle and authoritative room-state tests pass.

### Task 3: Online waiting lobby and synchronized game entry

**Files:**
- Modify: `js/views/home.js`
- Modify: `js/views/lobby.js`
- Modify: `js/views/game.js`
- Modify: `css/lobby.css`
- Modify: `test/regression.test.js`
- Modify: `test/e2e-checklist.md`

**Interfaces:**
- Consumes: Task 2's room session state and room events.
- Produces: server room creation/join navigates to a live waiting lobby; only the host may start after a guest joins; all clients enter the game on `ROOM_STARTED`; offline lobby behavior is preserved.

- [x] **Step 1: Add regression assertions** that online `joinSuccess` routes to the waiting lobby, online game entry is gated on `roomSession.phase === 'STARTED'`, and offline lobby flow remains present.
- [x] **Step 2: Run regression tests and confirm the current auto-start flow fails those assertions.**

Run: `node --test test/regression.test.js`

Expected: failures that identify automatic online game navigation and the missing game-phase gate.
- [x] **Step 3: Implement the online lobby mode.** Render the live server roster with text nodes, host and team labels, connection status, room code and copy-invite action. Hide AI filler controls in server mode; preserve all existing offline controls and start behavior. Host start remains disabled until at least one other player is present. Guests see “等待房主开始”.
- [x] **Step 4: Start the game from relay authority only.** Home join success navigates both host and guests to the lobby. The lobby sends `ROOM_START_REQUEST` and navigates to game only after `ROOM_STARTED`. Guard direct `/game` navigation while a server room is `WAITING`. Use the relay's `startAt` to align each client's countdown; keep offline countdown unchanged.
- [x] **Step 5: Run unit/regression tests and review the manual two-client checklist.** At initial implementation, Web 84/84 and relay 21/21 passed; local two-browser smoke verified the waiting lobby and synchronized start. Later hardening, live deployment, and the remaining UI/manual checks are recorded below.

Run: `node --test test/*.test.js && cd server && node --test test/*.test.js`

Expected: all Web and relay unit tests pass. Manual checklist confirms two clients stay in the lobby, roster changes propagate, the host alone starts, all clients enter on one start event, late join receives a clear reason, and offline AI start remains unchanged.

### Post-review hardening

- [x] Bind each socket to one player identity so repeated `JOIN_ROOM` packets cannot count one connection as multiple members. Add a relay test that proves a solo socket cannot satisfy the two-player start rule.
- [x] Keep empty `STARTED` rooms reconnectable until the planned match end plus 5 minutes, or 5 minutes after the last disconnect, whichever is later. Reject and reclaim expired rooms; retain known-player-only reconnect and add expiry tests.
- [x] Start server gameplay on the relay deadline even when geolocation is pending; acquire GPS independently and switch from simulated movement if it succeeds later.
- [x] Redirect the server lobby to home with an explanation when no room has been created or joined.
- [x] Require explicit create intent; an unknown or expired invite can no longer create a new room on retry. Clear provisional room state after failed create/join.
- [x] Initial post-hardening suites: Web 88/88, relay 23/23; local WebSocket flow verified explicit create, guest roster, host authority, shared deadline, and late-join rejection.
- [x] Final code review: the completed-room cleanup runs when a valid result page opens, covering Home, ranking, and replay exits.
- [x] Re-run complete suites after review fixes: Web 89/89 and relay 23/23; `git diff --check` passes.
- [x] Deploy the Web client and relay to `106.53.199.187`; public HTTPS and ICE endpoint return 200, all services are active, and a public WSS smoke verified explicit room creation, guest join, live roster, guest start rejection, and same-room chat.
- [ ] Fresh browser UI smoke with the deployed assets remains pending: browser-control tools are unavailable in this task context. The earlier two-browser UI smoke predates explicit-create hardening and is not counted as final UI verification. Real microphone/TURN audio also remains a manual device check.


### Final playtest and integration handoff (2026-09-30)

- [x] Public WSS playtest: explicit host creation returns a WAITING host; a guest joins and updates the roster; guest start is rejected; host start broadcasts the same startAt value; an unknown late join is rejected.
- [x] Regression fix: entering a valid result page clears the completed online session so Home, Rank, and Play Again cannot reopen the previous match. It also removes consumed server/passcode URL parameters; Home clears cached host and guest codes.
- [x] Final suites after all fixes: Web 89/89; relay 23/23. Final review found no remaining issue; deployed client hashes match the worktree.
- [x] Production services and endpoints rechecked: HTTPS and ICE config return 200; Nginx, relay, and Coturn are active.
- [ ] Final browser UI flow and real microphone/TURN audio remain manual. This task context had no browser-control surface or second microphone-enabled client; do not describe the wire playtest as a browser UI test.
- Integration: codex/web-online-features is to be merged locally into main after this playtest; record resulting commit IDs after merge.
