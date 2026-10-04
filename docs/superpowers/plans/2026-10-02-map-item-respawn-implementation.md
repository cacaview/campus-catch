# Server-Authoritative Map Item Respawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one shared set of up to eight map items per online room and replenish a picked-up item at a random in-area location after 30–90 seconds.

**Architecture:** A small relay-side map-item module samples valid points and creates item data. `RoomRegistry` owns each room's live item snapshot and respawn timers; the clients initialize and update their map from relay snapshots/events while offline games retain local spawning.

**Tech Stack:** Browser ES modules, Node.js ESM, WebSocket relay, `node:test`, Codex built-in browser and system Chrome.

**Spec:** [`docs/superpowers/specs/2026-10-02-verified-catch-and-item-respawn-design.md`](../specs/2026-10-02-verified-catch-and-item-respawn-design.md), sections 1, 2, 3.2, 4–7.

**Dependency:** Execute after [`2026-10-02-verified-catch-implementation.md`](2026-10-02-verified-catch-implementation.md). Both plans modify `RoomRegistry` and `game.js`; run the integrated browser verification only after both are complete.

## Global Constraints

- Keep at most 8 live room items; use relay-authoritative numeric IDs starting at 2001 and increment within the room.
- Generate an initial set at room start and later items only when a pickup creates a free slot; each queued respawn waits a random 30,000–90,000 ms.
- Every relay-created item must lie inside the room's valid polygon; invalid or absent polygons produce no items.
- The relay is the source of truth for online item creation, pickup acceptance, and reconnect snapshots. Offline item spawning remains local.
- Preserve existing worktree changes and modify the existing E2E checklist without rewriting or discarding prior manual results.
- Never connect browser verification to the production WSS service; use a local static HTTP server and local relay.

## Review Focus

1. **Concave polygon or malformed bounds:** generated points stay inside or generation returns no item. Pin in Task 1's `createsItemsOnlyInsideTheSelectedPolygon` and `doesNotSpawnForInvalidAreas` tests.
2. **Repeated/spoofed pickup or wrong team:** only an active item picked by an eligible team is removed once. Pin in Task 2's `acceptsAnEligibleActiveItemOnlyOnce` test.
3. **Multiple pending respawns and capacity:** no timer can create more than eight live items. Pin in Task 2's `respawnNeverExceedsTheActiveItemLimit` test.
4. **Activity deadline or room expiry during a pending respawn:** a callback after the planned end cannot create an item, and room deletion cancels timers. Pin in Task 2's `doesNotRespawnAfterActivityDeadline` and `cancelsRespawnsWhenTheExpiredRoomIsDeleted` tests; reconnect snapshot behavior is covered by `restoresCurrentItemsOnReconnect`.
5. **Duplicate `MAP_ITEM_SPAWN` or stale reconnect event:** client marker state remains unique and matches the latest relay snapshot. Pin in Task 3's `mapItemSnapshotsReplaceAndDeduplicateClientState` test.

---

### Task 1: Relay-side polygon sampling and item factory

**Files:**
- Create: `server/lib/map-items.js`
- Test: `server/test/map-items.test.js`

**Interfaces:**
- Consumes: room polygon `{ type: 'polygon', points: [{ latitude, longitude }, ...] }` and injected `random()` source.
- Produces: `isValidArea(area) -> boolean`, `containsPoint(area, point) -> boolean`, `createMapItem(area, id, random = Math.random) -> item | null`, and `createInitialMapItems(area, count = 8, random = Math.random, firstId = 2001) -> item[]`.

- [ ] **Step 1: Write failing pure-module tests.** Add `createsItemsOnlyInsideTheSelectedPolygon`, `doesNotSpawnForInvalidAreas`, and `createsUniqueSequentialInitialIds`. Use a concave polygon and seeded/injected deterministic random values; assert all returned coordinates pass `containsPoint`, count is at most eight, IDs are unique numeric values, and invalid input returns an empty set.
- [ ] **Step 2: Run the new test file and confirm the missing module fails.**

Run: `node --test server/test/map-items.test.js`

Expected: module import fails because the relay item factory is not present.
- [ ] **Step 3: Implement the bounded sampler and weighted item factory.** Use the existing client item types, icons, names, and category balance. Sample within polygon bounds, then check point-in-polygon; stop after 1,000 attempts for each point and return only valid points.
- [ ] **Step 4: Run the map-item helper tests.**

Run: `node --test server/test/map-items.test.js`

Expected: all generated points are inside the polygon, IDs are unique, and invalid areas return no items.
- [ ] **Step 5: Review and commit only this task's files.** Commit with `feat: generate online items inside room areas`.

### Task 2: Relay room snapshots, pickup validation, and timed respawn

**Files:**
- Modify: `server/lib/room-registry.js`
- Modify: `server/test/room-registry.test.js`
- Consumes: `server/lib/map-items.js`

**Interfaces:**
- `RoomRegistry` accepts injectable `random`, `scheduleTimer(callback, delayMs)`, and `cancelTimer(timerId)` options in addition to `now`.
- Each room owns `activeMapItems`, `nextMapItemId`, and a set of pending respawn timers.
- Relay packets `ROOM_STARTED`, `JOIN_ACK`, `MAP_ITEM_PICKUP`, and `MAP_ITEM_SPAWN` carry the authoritative item state required by clients.

- [ ] **Step 1: Write failing relay tests.** Add a valid polygon room fixture and tests named `includesInitialActiveItemsInRoomStarted`, `acceptsAnEligibleActiveItemOnlyOnce`, `rejectsWrongTeamAndUnknownItemPickups`, `sendsTheRespawnToTheWholeRoomAfterARandomDelay`, `respawnNeverExceedsTheActiveItemLimit`, `doesNotRespawnAfterActivityDeadline`, `restoresCurrentItemsOnReconnect`, and `cancelsRespawnsWhenTheExpiredRoomIsDeleted`. Use fake time, deterministic randomness, and a controllable timer queue; assert the chosen delay is within 30,000–90,000 ms, the new item is in the polygon, duplicate/stale pickups do not schedule another item, a callback at/after `startAt + gameDurationSeconds * 1000` does not create an item, and `JOIN_ACK` contains the current live items.
- [ ] **Step 2: Run the focused registry tests and confirm the new assertions fail.**

Run: `node --test server/test/room-registry.test.js`

Expected: new snapshot, team validation, timer, and reconnect assertions fail because room item state is not relay-owned.
- [ ] **Step 3: Implement room lifecycle ownership.** Inject timer/random functions for deterministic tests. Set `activityEndsAt = startAt + gameDurationSeconds * 1000`. Create initial items before broadcasting `ROOM_STARTED`; include live snapshots in `ROOM_STARTED` and successful `JOIN_ACK`. For a valid active pickup, enforce current-item membership and type eligibility (`CHEESE` for mouse, `CATNIP` for cat, `TRAP`/`BUSH` for either), remove once, broadcast the picker ID, and queue one 30–90 second spawn if the activity is still live and capacity is available. On timer fire, create and broadcast one new item only if `now() < activityEndsAt`, the polygon remains valid, and there is a free slot. Cancel all room timers on room deletion/expiry; leave timers and snapshots available across temporary disconnects.
- [ ] **Step 4: Run relay item and registry tests.**

Run: `node --test server/test/map-items.test.js server/test/room-registry.test.js`

Expected: all geometry, pickup, capacity, timer, snapshot, and existing room lifecycle tests pass.
- [ ] **Step 5: Review and commit only this task's staged hunks.** Commit with `feat: maintain and respawn authoritative room items`.

### Task 3: Client room snapshots and idempotent item state

**Files:**
- Modify: `js/utils/network/room-session.js`
- Modify: `js/utils/map-items.js`
- Test: `test/utils.test.js`
- Test: `test/network.test.js`

**Interfaces:**
- `RoomSession.activeMapItems` stores relay snapshots; `applyJoinAck(payload)` and `applyRoomStarted(payload)` replace it with sanitized item data, and `reset()` clears it.
- `MapItemsManager.setItems(items)` replaces local markers from a snapshot; `addItem(item) -> boolean` inserts only a valid item ID not already present; existing `removeItemById(id)` remains the pickup operation.

- [ ] **Step 1: Write failing session and manager tests.** Add `joinAckAndRoomStartedReplaceActiveMapItemSnapshots`, `resetClearsActiveMapItems`, and `mapItemSnapshotsReplaceAndDeduplicateClientState`. Assert snapshots are copied, repeated IDs are ignored, replacing a snapshot removes stale local items, and reset returns an empty list.
- [ ] **Step 2: Run focused tests and confirm the new state APIs are missing.**

Run: `node --test test/utils.test.js test/network.test.js`

Expected: the new assertions fail because `RoomSession` has no active-item snapshot and `MapItemsManager` has no snapshot/upsert methods.
- [ ] **Step 3: Implement snapshot and upsert methods.** Normalize numeric IDs and required coordinate/type fields; derive client icon/name through existing `MapItemsManager` helpers rather than trusting server-provided presentation fields.
- [ ] **Step 4: Run focused client tests.**

Run: `node --test test/utils.test.js test/network.test.js`

Expected: snapshots replace stale state, duplicate spawns do not duplicate markers, and existing offline pickup tests pass.
- [ ] **Step 5: Review and commit only this task's changes.** Commit with `feat: sync active map item snapshots to clients`.

### Task 4: Game view relay integration and offline preservation

**Files:**
- Modify: `js/views/game.js`
- Modify: `js/utils/network/protocol.js`
- Test: `test/regression.test.js`
- Modify: `test/e2e-checklist.md`

**Interfaces:**
- Consumes: Task 2 `ROOM_STARTED`/`JOIN_ACK` snapshots and `MAP_ITEM_SPAWN`/`MAP_ITEM_PICKUP`; Task 3 `RoomSession.activeMapItems` and item-manager methods.
- Produces: a game view whose online markers always come from relay state, while offline mode still calls local `spawnItems`.

- [ ] **Step 1: Write failing regression assertions.** Add `onlineMapItemsUseRelaySnapshotsAndOfflineSpawningRemainsLocal`. Assert online startup hydrates from `roomSession.activeMapItems`, spawn events call the idempotent add method and render, pickup events update both manager/session state, and offline startup retains local generation.
- [ ] **Step 2: Run the focused regression test and confirm it fails.**

Run: `node --test test/regression.test.js`

Expected: it fails because online startup currently generates items locally and no `MAP_ITEM_SPAWN` listener exists.
- [ ] **Step 3: Integrate relay state.** Add `MSG_TYPES.MAP_ITEM_SPAWN`. In online mode initialize from the room snapshot and stop generating seeded client items. On spawn, add once and render; on pickup, remove from both stores and render. On reconnect, replace with the fresh `JOIN_ACK` snapshot. Leave offline `spawnItems` behavior unchanged. Add checklist rows for area bounds, refresh, max active count, and reconnect state without disturbing existing results.
- [ ] **Step 4: Run focused and full automated suites.**

Run: `node --test test/regression.test.js`

Run: `node --test test/*.test.js`

Run: `node --test server/test/*.test.js`

Expected: all client and relay tests pass; the offline AI and local map-item behavior remains covered.
- [ ] **Step 5: Review and commit feature hunks only.** Commit with `feat: render relay-authoritative map items`.

### Task 5: Integrated two-browser acceptance

**Files:**
- Update: `test/e2e-checklist.md`

**Interfaces:**
- Consumes: both implementation plans; local static app at `http://localhost:8123` and local relay at `ws://localhost:8081/ws`.
- Produces: witnessed verification in Codex built-in browser and the system browser, with results recorded in the E2E checklist.

- [ ] **Step 1: Start only local services.** Run `python3 -m http.server 8123` from the project root and `node server/relay.js`; configure the game UI to use `ws://localhost:8081/ws`. Confirm `/healthz` is healthy. Do not use the production URL.
- [ ] **Step 2: Open two isolated browser clients.** Use Codex's built-in browser and the available system browser (Chrome; if unavailable, use Edge and record it). Confirm both load the current local files with no uncaught console errors.
- [ ] **Step 3: Verify a complete catch flow.** Create a local room in one browser as mouse and join from the other as cat; start the room. Confirm only mouse sees its code, an invalid code fails without a catch, a valid code broadcasts one result and increments the correct cat, and replaying the code fails. Then create a fresh room with cat/mouse roles exchanged and repeat.
- [ ] **Step 4: Verify online items and snapshots.** Use a compact valid polygon centered on the clients' start position so desktop simulated movement can reach an eligible item. Confirm initial markers are inside the selected area, observe a pickup, wait for the 30–90 second respawn, and verify a new shared marker appears inside the polygon without exceeding eight live markers. Reconnect one already joined client and confirm the live marker set matches. Confirm single-player AI still uses the offline path.
- [ ] **Step 5: Record only observed outcomes.** Update the checklist with the actual browser names, pass/fail result, any console errors, and refresh wait duration. Stop local processes after verification; do not deploy.
