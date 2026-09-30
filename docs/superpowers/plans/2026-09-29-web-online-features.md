# Web Online Chat and Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restore room text chat and the three mini-program voice channels in the Web game, then deploy the site and relay securely on `106.53.199.187`.

**Architecture:** Add a Node WebSocket relay for room chat and voice signaling, and use browser WebRTC mesh audio with Coturn fallback and an eight-speaker cap per channel. Nginx serves the static app and proxies HTTPS/WSS to the relay; Certbot provisions and renews an IP certificate.

**Tech Stack:** Native browser ES modules, WebRTC (`getUserMedia`, `RTCPeerConnection`), Node.js ESM, `ws`, `node:test`, Nginx, Certbot 5.4+, Coturn, systemd.

**Spec:** `docs/superpowers/specs/2026-09-29-web-online-features-design.md`

## Global Constraints

- Change only the Web project; do not edit the mini-program source tree.
- Keep all app and relay traffic same-origin: `https://106.53.199.187/`, `wss://106.53.199.187/ws`, and `/api/ice-config`.
- Preserve text chat's 50-character input limit and eight-message display window.
- Limit each voice channel to eight simultaneous participants; allow one channel per player.
- Do not store, record, or upload voice media; close local media tracks when leaving or disconnecting.
- Keep Coturn's shared secret on the server; issue client credentials with a 3600-second lifetime.
- Keep the browser app build-free and use only native Web APIs for media.
- If voice is unavailable, keep the game and text chat usable; after a network drop require a manual voice rejoin.
- Do not commit production TURN secrets, certificate private keys, or other server credentials.

## Review Focus

1. **Malformed or oversized WebSocket messages:** reject malformed JSON without crashing and close oversized frames with code 1009. Pin in Task 1's `relay.test.js` case `rejectsMalformedAndOversizedPackets`.
2. **Spoofed sender names and script-like chat text:** derive sender identity from the joined connection and display content as inert text. Pin sender handling in Task 1's `usesJoinedIdentityForChat` test and script handling in Task 2's browser checklist.
3. **Cross-room or cross-channel voice signaling:** do not deliver offers, answers, or ICE candidates to a peer outside the sender's game room and voice channel. Pin in Task 1's `routesVoiceSignalOnlyWithinSameRoomAndChannel` test.
4. **Microphone permission failure and leaving during pending setup:** show an error, never join the server roster without working local setup, and stop tracks if leave wins the race. Pin in Task 3's `reportsMediaFailureWithoutJoining` and `leaveCancelsPendingJoinAndStopsTracks` tests.
5. **Voice capacity and disconnect cleanup:** refuse the ninth participant, remove voice presence and peer connections on disconnect. Pin the cap and roster cleanup in Task 1's `enforcesVoiceLimitAndCleansDisconnectedMembers` test and Task 4's two-client checklist.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/relay.js` | HTTP health/config routes, `/ws` WebSocket wiring, process entry point |
| `server/lib/room-registry.js` | Game-room membership, chat broadcasts, voice rosters and scoped signaling |
| `server/lib/turn-credentials.js` | Short-lived Coturn REST credentials and ICE server configuration |
| `server/test/*.test.js` | Relay protocol and TURN credential tests |
| `js/config.js` | Default public WebSocket relay URL |
| `js/utils/network/protocol.js` | Chat and voice protocol names |
| `js/utils/voice-manager.js` | Browser media capture, peer connections, channel state and cleanup |
| `js/views/home.js` | Default relay URL while preserving invite/query overrides |
| `js/views/game.js` | Safe chat rendering and voice panel lifecycle/UI bindings |
| `css/game.css` | Responsive voice panel presentation |
| `test/voice-manager.test.js` | Voice manager tests with stubbed media and WebRTC interfaces |
| `test/e2e-checklist.md` | Manual two-client chat and audio checks |
| `deploy/nginx/game-web.conf` | HTTP challenge, HTTPS static hosting, health/WSS/API reverse proxy |
| `deploy/systemd/game-web-relay.service` | Relay process service |
| `deploy/turnserver.conf.example` | Coturn listener, external IP, authentication, and relay range template |
| `deploy/README.md` | Installation, certificate renewal, secrets, ports, and operations |

## Implementation Tasks

### Task 1: Room WebSocket relay and ephemeral TURN configuration

**Files:**
- Create: `server/package.json`, `server/package-lock.json`
- Create: `server/relay.js`
- Create: `server/lib/room-registry.js`
- Create: `server/lib/turn-credentials.js`
- Create: `server/test/room-registry.test.js`
- Create: `server/test/relay.test.js`
- Create: `server/test/turn-credentials.test.js`

**Interfaces:**
- `createRelayServer({ host = '127.0.0.1', port = 8081, publicIp, turnSecret, now = Date.now, maxPayloadBytes = 65536 })` returns `{ httpServer, webSocketServer, listen(), close() }`.
- `RoomRegistry({ maxVoiceMembers = 8, now = Date.now })` exposes `onConnection(ws)`, `handlePacket(ws, packet)`, and `removeConnection(ws)`.
- `createIceConfig({ publicIp, sharedSecret, nowMs = Date.now(), ttlSeconds = 3600 })` returns `{ iceServers, expiresAt }`; credentials use Coturn's shared-secret HMAC-SHA1 format.
- Incoming packets keep the existing `Protocol.encode()` envelope. New message types are `VOICE_JOIN`, `VOICE_LEAVE`, and `VOICE_SIGNAL`; server notifications are `VOICE_ROSTER`, `VOICE_PEER_JOINED`, `VOICE_PEER_LEFT`, and `VOICE_ERROR`.
- `VOICE_SIGNAL.payload` is `{ targetId, channel, signal }`; forwarded payload adds server-derived `fromId` and can reach only an online target in the same game room and voice channel.
- `VOICE_COUNTS_REQUEST` returns `{ counts: { global, cat, mouse } }` for the caller's game room; the relay broadcasts updated counts to that room after voice joins and leaves, without revealing member identities.

- [x] **Step 1: Create the ESM package/test harness** (`type: module`, `ws`, and `test` script) and write room-registry tests: `routesChatOnlyWithinJoinedRoom`, `usesJoinedIdentityForChat`, `forwardsExistingGameplayPacketsWithinRoom`, `rejectsWrongTeamForVoiceChannel`, `updatesRosterOnJoinAndLeave`, `routesVoiceSignalOnlyWithinSameRoomAndChannel`, and `enforcesVoiceLimitAndCleansDisconnectedMembers`. Add `relay.test.js` cases `healthEndpointReportsOk`, `iceConfigRequiresTurnSecret`, and `rejectsMalformedAndOversizedPackets`.
- [x] **Step 2: Run registry and relay tests and confirm they fail** with the missing modules/handlers.

Run: `cd server && npm install && node --test test/room-registry.test.js test/relay.test.js`

Expected: failures for the unimplemented relay state and routing behavior.

- [x] **Step 3: Implement `RoomRegistry`** with per-connection player state, passcode-room routing, the four-message-per-second chat limit, 50-character chat limit, JSON/protocol validation, server-owned sender identity, voice team/channel checks, voice member capacity enforcement, and room-scoped forwarding for every existing game `MSG_TYPES` packet.
- [x] **Step 4: Write TURN credential tests** for expiry, ICE URLs, deterministic HMAC credential generation, and missing secret handling.
- [x] **Step 5: Run TURN credential tests and confirm they fail** because `createIceConfig()` is missing.

Run: `cd server && node --test test/turn-credentials.test.js`

Expected: failures for the missing credential helper.

- [x] **Step 6: Implement `createIceConfig()`** with a one-hour username expiry and short-lived credentials; never return or log the shared secret.
- [x] **Step 7: Implement `createRelayServer()`** with `/healthz`, `/api/ice-config`, WebSocket path `/ws`, a 64 KiB payload ceiling that closes oversized frames with code 1009, malformed JSON rejection without process failure, missing-secret handling (503), and clean listen/close behavior for tests and systemd.
- [x] **Step 8: Run relay tests and review output.**

Run: `cd server && node --test test/*.test.js`

Expected: all room routing, validation, channel-capacity, cleanup, and credential tests pass.

- [x] **Step 9: Commit the relay service.**

### Task 2: Safe text chat and default WSS endpoint

**Files:**
- Create: `js/config.js`
- Modify: `js/views/home.js`
- Modify: `js/views/game.js`
- Modify: `test/e2e-checklist.md`

**Interfaces:**
- `js/config.js` exports `DEFAULT_RELAY_URL = 'wss://106.53.199.187/ws'`.
- Chat continues to use `MSG_TYPES.CHAT_MESSAGE` with `{ sender, text }`; the relay replaces the display sender with the joined player name.
- The join/invite query parameter continues to override the default server address.

- [x] **Step 1: Add browser checklist cases** for default relay prefill, query override, two-client same-room chat, different-room isolation, 50-character maximum, and `<img src=x onerror=alert(1)>` rendering literally.
- [x] **Step 2: Implement the default URL** in the server-mode field without overriding an invite URL or a user's manual edit.
- [x] **Step 3: Change chat rendering to DOM text nodes** (`textContent`) for sender and message rather than interpolation into `innerHTML`; retain the recent-eight display window and input limit.
- [x] **Step 4: Run the existing unit suite and verify the chat checklist locally** with the Node relay on `localhost:8081` and two browser contexts served from `localhost`.

Run: `node --test test/*.test.js`

Expected: existing tests pass; default/query URL handling, same-room delivery, room isolation, message length, and inert rendering pass in the local browser.

- [x] **Step 5: Commit the safe chat and default endpoint.**

### Task 3: Browser WebRTC voice manager

**Files:**
- Modify: `js/utils/network/protocol.js`
- Create: `js/utils/voice-manager.js`
- Create: `test/voice-manager.test.js`

**Interfaces:**
- `new VoiceManager({ networkManager, player, fetchIceConfig, mediaDevices, createPeerConnection })`; `player` is `{ id, name, team }`.
- Public methods: `join(channel) -> Promise<{ ok, error? }>`, `leave() -> Promise<void>`, `setMuted(muted) -> boolean`, `destroy() -> void`, `on(event, handler)`, and `off(event, handler)`.
- Read-only snapshot: `{ state, channel, muted, members }`, where state is `IDLE`, `JOINING`, or `IN_CALL` and members are server-authorized `{ id, name, team }` records.
- Events: `stateChange(snapshot)`, `membersChange(members)`, and `error({ message })`.
- `refreshChannelCounts()` requests room-local aggregate counts; `countsChange(counts)` reports authoritative channel counts for UI cards.
- Only `global`, `cat`, and `mouse` are accepted. Team mismatch, offline networking, and a server-reported full channel reject the join.

- [x] **Step 1: Write named tests**: `joinsAllowedChannelWithMicAndIceConfig`, `reportsMediaFailureWithoutJoining`, `rejectsTeamMismatch`, `muteTogglesLocalTracks`, `onlyLowerPlayerIdCreatesOffer`, `handlesIncomingOfferAnswerAndIce`, `peerLeftClosesConnection`, `leaveCancelsPendingJoinAndStopsTracks`, and `networkDisconnectStopsTracksAndRequiresManualRejoin`.
- [x] **Step 2: Run the focused tests and confirm the manager behavior is missing.**

Run: `node --test test/voice-manager.test.js`

Expected: failures for the missing manager and its public methods/events.

- [x] **Step 3: Add voice message constants** to `MSG_TYPES` without changing existing protocol names.
- [x] **Step 4: Implement `VoiceManager`** using injected media/network adapters, a join-generation token for cancellation, one mic stream, a map of peer connections, deterministic initiator ordering by player ID, and remote audio elements. Do not send `VOICE_JOIN` until local microphone and ICE setup succeed.
- [x] **Step 5: Implement cleanup and reconnection behavior:** disable/stop all local tracks, close peer connections/audio elements, send `VOICE_LEAVE`, and require manual rejoin after network reconnection.
- [x] **Step 6: Run voice and existing network tests.**

Run: `node --test test/voice-manager.test.js test/network.test.js`

Expected: voice tests pass and existing network lifecycle behavior remains unchanged.

- [x] **Step 7: Commit the WebRTC voice manager.**

### Task 4: Game voice panel and lifecycle integration

**Files:**
- Modify: `js/views/game.js`
- Modify: `css/game.css`
- Modify: `test/e2e-checklist.md`

**Interfaces:**
- `game.js` owns a `VoiceManager` only while the network game view is active; end-game and `onHide` destroy it. On relay disconnect, the manager stops media and peers but stays alive to report the disconnected state and require a manual rejoin after networking recovers.
- The voice panel renders three channel cards, member counts, join state, microphone mute state, error text, close, and leave controls.
- Per-channel counts are room-scoped, include at most eight members, and update whenever a participant joins or leaves a voice channel.
- Closing the panel keeps the connection; explicit leave or game lifecycle cleanup terminates it.

- [x] **Step 1: Add UI checklist cases** for offline disabled state, channel counts, join/switch/leave, mute, panel close while still joined, media permission denial, and cleanup on game end.
- [x] **Step 2: Add the panel markup and CSS** following current mobile-safe game overlays and toolbar styles.
- [x] **Step 3: Wire game lifecycle and UI controls** to the Task 3 manager; render the disabled explanation in offline mode and keep all existing game input handlers.
- [x] **Step 4: Run unit and browser regression checks.**

Run: `node --test test/*.test.js`

Expected: all unit tests pass. In a browser, the checklist's existing single-player flows still pass and the voice panel is usable at 375×812.

- [x] **Step 5: Commit voice panel integration.**

### Task 5: Nginx, Coturn, systemd, and certificate deployment files

**Files:**
- Create: `deploy/nginx/game-web.conf`
- Create: `deploy/systemd/game-web-relay.service`
- Create: `deploy/turnserver.conf.example`
- Create: `deploy/README.md`
- Modify: `README.md`

**Interfaces:**
- Node relay listens on `127.0.0.1:8081`; Nginx proxies `/ws` with WebSocket upgrade and `/api/` to the same local service.
- Nginx serves the app from `/var/www/game-web`, serves ACME webroot challenges on TCP 80, and serves HTTPS on TCP 443 using Certbot's `/etc/letsencrypt/live/106.53.199.187/{fullchain,privkey}.pem` files. `/healthz`, `/ws`, and `/api/` proxy to the loopback relay.
- Relay environment keys: `PORT=8081`, `HOST=127.0.0.1`, `PUBLIC_IP=106.53.199.187`, and a server-only `TURN_SECRET`.
- Coturn uses shared-secret auth, public/private address mapping, listeners on UDP/TCP 3478, and UDP relay ports 49160–49200.

- [x] **Step 1: Write the deploy runbook** with package requirements, filesystem ownership, server-only secret creation, certificate command, service start order, renewal timer/hook, and cloud security-group ports.
- [x] **Step 2: Add Nginx and systemd configs** for static hosting, HTTP ACME challenges, HTTPS redirects, `/healthz`, `/ws` upgrade headers, `/api/` proxy, loopback-only relay, a dedicated unprivileged relay account, and restart-on-failure.
- [x] **Step 3: Add the Coturn example config** with placeholders for public/private IP and shared secret, not actual credentials.
- [x] **Step 4: Review config syntax locally where supported** and ensure no certificate key, TURN secret, or private address credential is tracked. Nginx, systemd-analyze, and nft syntax tools are not installed locally; remote syntax checks remain part of Task 6.

Run: `git diff --check`

Expected: no whitespace issues; repository config contains placeholders only and uses the spec's exact ports/paths.

- [x] **Step 5: Commit deployment configuration and runbook.**

### Task 6: Deploy on the Debian server and verify the public service

**Files:**
- Modify: `test/e2e-checklist.md` with deployed URL and final results
- Modify: `README.md` with operational URL and concise restart/renewal notes

**Interfaces:**
- Public app: `https://106.53.199.187/`.
- Public WebSocket: `wss://106.53.199.187/ws`.
- Public ICE configuration: `https://106.53.199.187/api/ice-config`.
- Server process: systemd unit `game-web-relay.service`; Coturn managed by its systemd unit; Nginx serves TLS and static assets.

- [x] **Step 1: Recheck the remote OS and firewall prerequisites** before installing packages and verify key-only SSH. Confirm the cloud security group allows TCP 22, 80, and 443; TCP and UDP 3478; and UDP 49160–49200. Preserve TCP 22 throughout. If the cloud rule cannot be changed here and a required port is blocked, stop before deployment and report the exact rule needed.
- [x] **Step 2: Install Node.js, Nginx, Coturn, nftables, and Certbot 5.4+** on Debian 13; keep relay and TURN secrets in a root-owned mode-`0600` environment file.
- [x] **Step 3: Deploy the Web app and relay** into `/var/www/game-web` and `/opt/game-web/server`, install production dependencies, configure TURN's public/private IP mapping, and start the HTTP-only Nginx ACME challenge configuration.
- [x] **Step 4: Configure the host firewall with nftables** to allow established traffic, loopback, TCP 22/80/443, TCP+UDP 3478, and UDP 49160–49200, with a default-deny inbound policy. Keep the current SSH session open, establish and verify a second SSH session, then enable and persist the rules. Confirm the public ports are reachable before proceeding.
- [x] **Step 5: Request an ACME staging IP certificate first** with Certbot's `--webroot`, `--ip-address 106.53.199.187`, and `--preferred-profile shortlived`; confirm HTTP-01 reachability, then request the production certificate and enable automatic renewal plus Nginx reload hook.
- [x] **Step 6: Install the full HTTPS/WSS Nginx config** and validate it with `nginx -t`; validate the systemd unit with `systemd-analyze verify`, then enable Coturn, relay, Nginx, and renewal services.
- [x] **Step 7: Verify public HTTPS, certificate SAN/expiry, `/healthz`, WSS handshake, same-room chat, different-room isolation, `/api/ice-config` expiry, and systemd/timer status.**
- [ ] **Step 8: Run two-client browser checks on separate devices or networks** for real audio, channel isolation, roster counts, mute, leave, and permission denial. Protocol checks and voice-manager tests pass; final two-device microphone/TURN media and deployed lobby UI remain manual because browser controls and a second microphone-enabled client were unavailable.
- [x] **Step 9: Record actual deployment results** in the checklist and README, then commit deployment notes only after checking them against the live server.

### Post-deployment review hardening (2026-09-29)

- [x] Keep a room registered when its only member reconnects; add a relay regression test and verify the behavior against the public WSS endpoint.
- [x] Send `VOICE_LEAVE` when a pending server voice join is canceled or times out; verify the cancellation path and stop local media tracks.
- [x] Limit public ICE credential requests per source IP, issue a unique temporary TURN username per config grant, and bound Coturn per-user/total allocations and per-session bandwidth.
- [x] Replace only the project-owned nftables table; validate the rules and establish a fresh SSH connection after applying them.
- [ ] Verify real two-device WebRTC media with microphone permission; retain as a manual check.

## Plan Self-Review

- **Spec coverage:** UI, room chat, plain-text rendering, signaling, room/team isolation, voice limit, cleanup, Coturn short credentials, HTTPS/WSS, IP certificate renewal, systemd, firewall ports, and ephemeral state each map to Tasks 1–6.
- **Step clarity:** Each code task names its files, interfaces, tests, and expected result. Live-server operations are isolated to Task 6 and use explicit public paths and ports.
- **Interface consistency:** Client event names and relay notifications use the same `VOICE_*` names; relay, ICE endpoint, Nginx proxy, and client configuration all agree on port `8081`, `/ws`, and `/api/ice-config`.
- **Review focus:** The five likely failures above map to explicit unit or browser checks in the owning task.
- **Proportion:** The plan specifies testable contracts and deployment boundaries without embedding full server or media implementation code.
