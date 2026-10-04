# Verified Online Catch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a server-room capture count only after a mouse privately receives a one-time code and a cat submits it for relay verification.

**Architecture:** The relay issues and consumes codes, checks the bound room members and teams, and creates the only accepted `CATCH_EVENT`. The game view provides separate mouse-display and cat-entry controls; offline AI keeps its current simulated capture behavior.

**Tech Stack:** Browser ES modules, existing WebSocket `NetworkManager`, Node.js ESM `RoomRegistry`, `node:test`.

**Spec:** [`docs/superpowers/specs/2026-10-02-verified-catch-and-item-respawn-design.md`](../specs/2026-10-02-verified-catch-and-item-respawn-design.md), sections 1–6.

## Global Constraints

- A code is six digits, expires after 120 seconds, and only the latest code requested by a mouse remains valid.
- The relay sends a code only to its requesting mouse; each cat may make at most 5 failed attempts per 30 seconds and each mouse may request at most one code per 2 seconds.
- The relay derives the cat and mouse identities from their joined sockets; it rejects client-authored `CATCH_EVENT` packets.
- Online capture never depends on GPS distance or a proximity timer; the existing offline AI simulation remains unchanged.
- Preserve existing worktree changes. Stage only feature hunks; do not stage unrelated home/lobby edits or use `git add .`.

## Review Focus

1. **Same code submitted twice or concurrently:** exactly one success is broadcast. Pin in Task 1's `verifiesAndConsumesCatchCodeOnceUsingBoundSocketIdentity` test.
2. **Expired, wrong-team, disconnected, or cross-room code:** verification fails without broadcasting a catch or awarding score. Pin in Task 1's `rejectsInvalidCatchCodeContexts` test.
3. **Spoofed client `CATCH_EVENT`:** it cannot reach other room members. Pin in Task 1's `rejectsClientAuthoredCatchEvent` test and remove `CATCH_EVENT` from the generic forwarding fixture.
4. **Wrong client receives an issued code:** only the requesting mouse socket receives it. Pin in Task 1's `issuesOneTimeCatchCodeOnlyToRequestingMouse` test.
5. **Player names are duplicated:** score, catch count, and achievement credit use player IDs. Pin in Task 3's `verifiedCatchAwardsOnlyTheMatchingCatId` regression test.

---

### Task 1: Relay-owned catch-code lifecycle

**Files:**
- Modify: `server/lib/room-registry.js`
- Test: `server/test/room-registry.test.js`

**Interfaces:**
- Consumes: joined socket state (`state.room`, `state.player`), room phase, `RoomRegistry.now`.
- Produces: `handleCatchCodeRequest(state)` and `handleCatchCodeVerify(state, payload)`; private `CATCH_CODE_ISSUED` / `CATCH_CODE_ERROR` packets; relay-authored room-wide `CATCH_EVENT` packets containing `catId`, `catName`, `mouseId`, and `mouseName`.

- [ ] **Step 1: Write failing relay tests.** Add started-room fixtures and tests named `issuesOneTimeCatchCodeOnlyToRequestingMouse`, `verifiesAndConsumesCatchCodeOnceUsingBoundSocketIdentity`, `rejectsInvalidCatchCodeContexts`, `rateLimitsCatchCodeRequestsAndFailedVerifications`, and `rejectsClientAuthoredCatchEvent`. Assert a six-digit code with `expiresAt === now + 120000`; only the requesting mouse gets the code; event identities come from sockets despite spoofed payload IDs/names; replay and simultaneous duplicate verification create one event; invalid cases create no event; room forwarding never forwards a client-authored `CATCH_EVENT`.
- [ ] **Step 2: Run the focused tests and confirm they fail for the missing behavior.**

Run: `node --test server/test/room-registry.test.js`

Expected: the new catch-code tests fail because the relay does not route issuance/verification and currently forwards `CATCH_EVENT` generically.
- [ ] **Step 3: Implement server-authoritative validation.** Add room maps for each mouse's outstanding code and for per-cat failed-attempt timestamps. Generate an active-code-unique value with `crypto.randomInt(100000, 1000000)`, replace the mouse's previous code, and send it only to that socket. Expire at 120 seconds. Validate room phase, requester/target teams, target connection, room membership, code ownership, and expiry before synchronously consuming the code and broadcasting. Enforce the two rate limits in Global Constraints. Route these packet types explicitly and remove `CATCH_EVENT` from `GAME_PACKET_TYPES`.
- [ ] **Step 4: Run relay tests and confirm the focused suite passes.**

Run: `node --test server/test/room-registry.test.js`

Expected: all room-registry tests pass, including the new private-issuance, one-use, invalid-context, rate-limit, and spoof-rejection cases.
- [ ] **Step 5: Review and commit only this task's staged changes.** Inspect `git diff --cached --check` and `git diff --cached --name-only`, then commit with `feat: verify online catches with one-time codes`.

### Task 2: Client protocol constants and event delivery

**Files:**
- Modify: `js/utils/network/protocol.js`
- Test: `test/network.test.js`

**Interfaces:**
- Consumes: Task 1 packet names and payloads.
- Produces: `MSG_TYPES.CATCH_CODE_REQUEST`, `CATCH_CODE_ISSUED`, `CATCH_CODE_VERIFY`, and `CATCH_CODE_ERROR`. Existing generic `NetworkManager` event delivery emits these packets and server-authored `CATCH_EVENT` by type.

- [ ] **Step 1: Write failing network tests.** Add `catchCodeMessagesCanBeSentAndReceived` to assert the four constants, `NetworkManager.send()` serializes the request and verify packet types, and `handleIncomingMessage()` emits issued/error/catch events with their payloads unchanged.
- [ ] **Step 2: Run the focused test and confirm the missing protocol constants fail.**

Run: `node --test test/network.test.js`

Expected: the new test fails on the absent constants.
- [ ] **Step 3: Add the protocol constants.** Do not add duplicate message-routing branches to `NetworkManager`; its default case already emits server events unchanged.
- [ ] **Step 4: Run the focused network suite.**

Run: `node --test test/network.test.js`

Expected: all network tests pass, including unchanged event payload delivery.
- [ ] **Step 5: Review and commit only this task's staged changes.** Inspect the staged diff and commit with `feat: define verified catch protocol messages`.

### Task 3: Mouse code display and cat verification UI

**Files:**
- Modify: `js/views/game.js`
- Modify: `css/game.css`
- Test: `test/regression.test.js`

**Interfaces:**
- Consumes: Task 2 `MSG_TYPES` and Task 1's issued/error/catch payloads.
- Produces: mouse-only “出示抓捕码” and cat-only “核验抓捕码” controls; a private code display and cat code-entry dialog; `onCatchEvent(payload)` that records success by IDs.

- [ ] **Step 1: Write failing UI regression tests.** Add `verifiedCatchUIRequiresCodeEntryAndUsesPlayerIds` and `verifiedCatchAwardsOnlyTheMatchingCatId`. Assert both controls and the input/display UI exist only in server mode for the matching team, the relay verify message is sent only from the cat control, successful catch accounting compares `catId` to the local player ID, and the online view does not use the offline proximity branch to award captures.
- [ ] **Step 2: Run the focused regression tests and confirm the expected assertions fail.**

Run: `node --test test/regression.test.js`

Expected: the new tests fail because no online catch controls or ID-based accounting exist.
- [ ] **Step 3: Implement the UI in `game.js` and `game.css`.** Add the team-specific controls, private modal content, six-digit input validation, submit/cancel behavior, pending/error feedback, and event listeners with view lifecycle cleanup. On `CATCH_CODE_ISSUED`, show the code only to the requesting mouse. On `CATCH_CODE_ERROR`, show a generic invalid/expired/retry message. On relay `CATCH_EVENT`, award the existing capture score and achievement only to the local `catId`, and update catch counts by IDs; keep the existing offline AI branch intact.
- [ ] **Step 4: Run client regression and network suites.**

Run: `node --test test/regression.test.js`

Run: `node --test test/network.test.js`

Expected: all existing and new checks pass; offline AI capture regression remains covered by the existing E2E checklist.
- [ ] **Step 5: Review and commit only this task's staged changes.** Preserve previously modified hunks and commit with `feat: add manual online catch verification UI`.

### Task 4: Catch feature local integration gate

**Files:**
- Review: `js/views/game.js`, `server/lib/room-registry.js`
- Test: `server/test/room-registry.test.js`, `test/network.test.js`, `test/regression.test.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a locally verified relay/UI wire flow, ready for the combined two-browser pass in the item-respawn plan.

- [ ] **Step 1: Run the relay, network, and regression test files together.**

Run: `node --test server/test/room-registry.test.js test/network.test.js test/regression.test.js`

Expected: all named test files pass.
- [ ] **Step 2: Review packet/data flow once.** Confirm no code value appears in a room broadcast, `CATCH_EVENT` is server-authored only, and GPS proximity cannot issue or consume a code.
- [ ] **Step 3: Record task completion in the plan.** The Codex built-in and system-browser functional pass is intentionally deferred until both this plan and the item-respawn plan are complete.
