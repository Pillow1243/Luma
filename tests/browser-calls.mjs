/**
 * Browser-level WebRTC smoke test. The media connections are real Chromium
 * RTCPeerConnections, using fake capture devices and localhost ICE candidates;
 * all Supabase REST and Realtime traffic is mocked in-memory. It deliberately
 * reorders participant snapshots and simulates an accepted answer whose HTTP
 * response is lost. This does not verify the live Supabase project, TURN,
 * real capture prompts, or Android.
 *
 * Run after `npm run build`: CHROME_PATH=/path/to/chromium npm run test:browser:calls
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const exe = process.env.CHROME_PATH || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/tmp/chromium"].find(existsSync);
if (!exe) throw new Error("Chromium not found. Set CHROME_PATH to a Chromium or Chrome executable.");
const root = path.resolve("dist");
if (!existsSync(path.join(root, "index.html"))) throw new Error("Build the app before the browser smoke test: npm run build");

// A tiny temporary static server avoids depending on an already-running dev server.
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://luma.test");
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === "/" || !path.extname(pathname) ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
    const contents = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    res.end(contents);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
const port = server.address().port;
const origin = `http://localhost:${port}`;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "55555555-5555-4555-8555-555555555555";
const CHAT = "33333333-3333-4333-8333-333333333333";

async function runScenario(group) {
  const now = new Date().toISOString();
  const profiles = [[A, "Alice"], [B, "Bob"], ...(group ? [[C, "Charlie"]] : [])].map(([id, display_name]) => ({ id, display_name, username: display_name.toLowerCase(), avatar_path: null, created_at: now, bio: "", show_last_seen: true }));
  const members = profiles.map((p) => ({ chat_id: CHAT, user_id: p.id, last_read_at: now, last_seen_at: null, typing_until: null, is_admin: false, muted_until: null, archived_at: null }));
  const chat = { id: CHAT, name: group ? "Test group" : null, is_group: group, created_by: A, created_at: now, avatar_path: null, ttl_seconds: null, kind: group ? "group" : "direct", description: "", username: null, is_public: false };
  let calls = [], participants = [], signals = [], sockets = [], nextId = 1;
  let staleCaptured = false;
  let releaseStale;
  const staleGate = new Promise((resolve) => { releaseStale = resolve; });
  let lostSignalId = null;
  let signalRetried;
  const signalRetry = new Promise((resolve) => { signalRetried = resolve; });
  const publicKeys = {}, errors = [], browsers = [], contexts = [], events = [];
  const equal = (url, key) => url.searchParams.get(key)?.replace(/^eq\./, "");
  const matchRows = (url, rows, fields) => rows.filter((row) => fields.every((key) => !url.searchParams.get(key)?.startsWith("eq.") || row[key] === equal(url, key)));
  function emit(table, type, row) {
    events.push({ table, type, ...row });
    for (const socket of sockets) for (const channel of socket.channels.values()) {
      const ids = channel.filters.filter((filter) => {
        const [key, value] = (filter.filter ?? "").split("=eq.");
        return filter.table === table && (filter.event === "*" || filter.event === type) && (!filter.filter || String(row[key]) === value);
      }).map((filter) => filter.id);
      if (ids.length) socket.ws.send(JSON.stringify([channel.joinRef, null, channel.topic, "postgres_changes", { ids, data: { schema: "public", table, commit_timestamp: new Date().toISOString(), type, columns: [], record: row, old_record: {}, errors: null } }]));
    }
  }

  async function openClient(user) {
    // Separate browser processes also work with single-process/headless-shell
    // builds, where multiple contexts may unexpectedly share localStorage.
    const browser = await chromium.launch({ executablePath: exe, headless: true, args: [
      "--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ] });
    browsers.push(browser);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["camera", "microphone"] });
    contexts.push(context);
    await context.addInitScript(({ user }) => {
      const encode = (value) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
      const jwt = `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: user, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 86400 })}.x`;
      localStorage.setItem("luma-auth", JSON.stringify({ access_token: jwt, refresh_token: "test", token_type: "bearer", expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: user, aud: "authenticated", role: "authenticated", email: "test@example.invalid", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } }));
      const Native = window.RTCPeerConnection;
      window.__lumaPeers = [];
      window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.__lumaPeers.push(this); } };
    }, { user });
    await context.routeWebSocket(/wss:\/\/.*\.supabase\.co\/realtime\/v1\/websocket.*/, (ws) => {
      const socket = { ws, channels: new Map() }; sockets.push(socket);
      ws.onMessage((raw) => {
        if (typeof raw !== "string") return;
        const [joinRef, ref, topic, event, payload] = JSON.parse(raw);
        if (event === "phx_join") {
          const filters = (payload.config?.postgres_changes ?? []).map((filter) => ({ ...filter, id: nextId++ }));
          socket.channels.set(topic, { topic, joinRef: ref, filters });
          ws.send(JSON.stringify([ref, ref, topic, "phx_reply", { status: "ok", response: { postgres_changes: filters } }]));
        } else if (event === "phx_leave") {
          socket.channels.delete(topic); ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
        } else if (event === "heartbeat") ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
      });
      ws.onClose(() => { sockets = sockets.filter((item) => item !== socket); });
    });
    await context.route("https://*.supabase.co/**", async (route) => {
      const request = route.request(), url = new URL(request.url()), table = url.pathname.split("/").pop(), method = request.method();
      let data = [], status = 200;
      try {
        if (table === "profiles") data = matchRows(url, profiles, ["id"]);
        else if (table === "chat_participants") data = matchRows(url, members, ["user_id", "chat_id"]);
        else if (table === "chats") data = matchRows(url, [chat], ["id"]);
        else if (table === "user_public_keys") {
          if (method === "POST") { const row = request.postDataJSON(); publicKeys[row.user_id] = row.public_key; data = null; status = 201; }
          else data = Object.entries(publicKeys).map(([user_id, public_key]) => ({ user_id, public_key })).filter((row) => !equal(url, "user_id") || row.user_id === equal(url, "user_id"));
        } else if (table === "calls") data = matchRows(url, calls, ["id", "chat_id"]);
        else if (table === "call_participants") {
          data = matchRows(url, participants, ["call_id", "user_id", "status"]);
          // Deterministically delay an older ringing snapshot until after the
          // newer joined snapshot has established a group call. Real network
          // requests and Realtime updates can arrive in this order.
          if (group && user === A && equal(url, "call_id") && !staleCaptured && data.some((row) => row.status === "ringing")) {
            data = structuredClone(data);
            staleCaptured = true;
            await staleGate;
          }
        }
        else if (table === "call_signals") {
          if (method === "POST") {
            const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...request.postDataJSON() };
            if (lostSignalId === row.id) signalRetried(row.id);
            if (signals.some((signal) => signal.id === row.id)) {
              data = { code: "23505", message: "duplicate key" }; status = 409;
            } else {
              signals.push(row);
              setTimeout(() => emit("call_signals", "INSERT", row), 10);
              if (!lostSignalId && row.kind === "answer") {
                // The server accepted this answer but its response was lost.
                // A retry must preserve its id even if the receiver deletes it.
                lostSignalId = row.id;
                data = { message: "simulated lost response" }; status = 503;
              } else { data = null; status = 201; }
            }
          }
          else if (method === "DELETE") { signals = signals.filter((row) => row.id !== equal(url, "id")); data = null; }
          else data = matchRows(url, signals, ["call_id", "to_user"]);
        } else if (table === "start_luma_call") {
          const input = request.postDataJSON(), time = new Date().toISOString();
          const call = { id: crypto.randomUUID(), chat_id: input.cid, started_by: user, kind: input.call_kind, status: "ringing", created_at: time, answered_at: null, ended_at: null };
          const rows = profiles.map((p) => ({ call_id: call.id, user_id: p.id, status: p.id === user ? "joined" : "ringing", joined_at: p.id === user ? time : null, left_at: null }));
          calls.push(call); participants.push(...rows); data = call;
          setTimeout(() => rows.forEach((row) => emit("call_participants", "INSERT", { ...row })), 15);
        } else if (table === "respond_luma_call") {
          const input = request.postDataJSON(), participant = participants.find((p) => p.call_id === input.call_uuid && p.user_id === user), call = calls.find((c) => c.id === input.call_uuid);
          participant.status = input.accept_call ? "joined" : "declined";
          // Equal group join timestamps exercise the user-ID tie breaker.
          participant.joined_at = input.accept_call ? (group ? new Date(Date.parse(call.created_at) + 1).toISOString() : new Date().toISOString()) : null;
          if (input.accept_call) { call.status = "active"; call.answered_at = new Date().toISOString(); }
          data = null; setTimeout(() => { emit("call_participants", "UPDATE", { ...participant }); emit("calls", "UPDATE", { ...call }); }, 15);
        } else if (table === "leave_luma_call") {
          const input = request.postDataJSON(), call = calls.find((c) => c.id === input.call_uuid), participant = participants.find((p) => p.call_id === input.call_uuid && p.user_id === user);
          if (participant) participant.status = "left";
          const joined = participants.filter((p) => p.call_id === input.call_uuid && p.status === "joined").length;
          const ringing = participants.filter((p) => p.call_id === input.call_uuid && p.status === "ringing").length;
          if (call && (joined === 0 || (joined <= 1 && (ringing === 0 || call.answered_at)))) { call.status = "ended"; call.ended_at = new Date().toISOString(); }
          data = null; setTimeout(() => { if (participant) emit("call_participants", "UPDATE", { ...participant }); if (call?.status === "ended") emit("calls", "UPDATE", { ...call }); }, 15);
        }
        if (method === "PATCH" || method === "DELETE") data = null;
        if ((request.headers().accept ?? "").includes("vnd.pgrst.object") && Array.isArray(data)) data = data[0] ?? null;
        await route.fulfill({ status, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify(data) });
      } catch (error) {
        errors.push(`Mock ${table}: ${error.message}`);
        await route.fulfill({ status: 500, body: JSON.stringify({ message: error.message }) });
      }
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (entry) => {
      if (entry.type() === "error" && lostSignalId && entry.text().includes("status of 503")) console.log("Browser", user, "observed the expected simulated lost response");
      else if (["error", "warning"].includes(entry.type())) console.error("Browser", user, entry.type(), entry.text());
      if (/\[Luma\] (could not process call signal|call offer failed|signaling failed)/.test(entry.text())) errors.push(entry.text());
    });
    // Localhost is a secure context and the app uses hash routing there.
    await page.goto(`${origin}/#/chat/${CHAT}`, { waitUntil: "domcontentloaded" });
    return page;
  }

  let pages = [];
  try {
    pages = await Promise.all(profiles.map((p) => openClient(p.id)));
    const [caller, ...recipients] = pages;
    const kind = group ? "audio" : "video";
    await Promise.all(pages.map((page) => page.getByRole("button", { name: `Start ${kind} call` }).waitFor({ timeout: 20000 })));
    await Promise.all(pages.map((page) => page.waitForFunction(() => !document.body.innerText.includes("Reconnecting"), null, { timeout: 20000 })));
    await caller.getByRole("button", { name: `Start ${kind} call` }).click();
    await Promise.all(recipients.map((page) => page.getByRole("dialog", { name: "Incoming call" }).waitFor({ timeout: 20000 })));
    await Promise.all(recipients.map((page) => page.getByRole("button", { name: "Accept call" }).click()));
    await Promise.all(pages.map((page) => page.waitForFunction((count) => window.__lumaPeers.filter((pc) => pc.connectionState === "connected").length >= count, pages.length - 1, { timeout: 40000 })));
    let retryTimeout;
    try {
      const retriedId = await Promise.race([signalRetry, new Promise((_, reject) => { retryTimeout = setTimeout(() => reject(new Error("answer retry did not preserve its ID")), 5000); })]);
      assert.equal(retriedId, lostSignalId, "a retry must reuse the originally accepted signal ID");
      // Let any duplicate Realtime event arrive before checking for errors.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally { clearTimeout(retryTimeout); }
    if (group) {
      assert.ok(staleCaptured, "test must capture a stale ringing snapshot");
      releaseStale();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(await caller.evaluate(() => window.__lumaPeers.filter((pc) => pc.connectionState === "connected").length), pages.length - 1, "a stale ringing snapshot must not close connected peers");
    }
    for (const page of pages) {
      const connections = await page.evaluate(() => window.__lumaPeers.filter((pc) => pc.connectionState === "connected").map((pc) => pc.getReceivers().map((receiver) => receiver.track.kind)));
      assert.ok(connections.every((tracks) => tracks.includes("audio")), "each connected peer must receive an audio track");
      if (!group) assert.ok(connections.every((tracks) => tracks.includes("video")), "video call must receive a video track");
    }

    // Model display capture with another fake video source, then check that
    // the answerer sends it on negotiated transceivers and restores its camera.
    const sharer = recipients[0];
    const camera = await sharer.evaluate(() => window.__lumaPeers[0].getSenders().find((sender) => sender.track?.kind === "video")?.track.id ?? null);
    await sharer.evaluate(() => { navigator.mediaDevices.getDisplayMedia = () => navigator.mediaDevices.getUserMedia({ video: true }); });
    await sharer.getByRole("button", { name: "Share", exact: true }).click();
    await sharer.getByRole("button", { name: "Stop share", exact: true }).waitFor({ timeout: 10000 });
    const senders = await sharer.evaluate(() => window.__lumaPeers.filter((pc) => pc.connectionState === "connected").map((pc) => pc.getTransceivers().filter((transceiver) => transceiver.receiver.track.kind === "video").map((transceiver) => ({ mid: transceiver.mid, direction: transceiver.currentDirection, trackId: transceiver.sender.track?.id }))));
    assert.ok(senders.every((list) => list.some((t) => t.mid !== null && t.direction === "sendrecv" && t.trackId && t.trackId !== camera)), "screen track must use negotiated sendrecv video sections");
    if (group) await Promise.all(pages.filter((page) => page !== sharer).map((page) => page.waitForFunction(() => Array.from(document.querySelectorAll("video")).filter((video) => !video.muted && video.srcObject).some((video) => video.srcObject.getVideoTracks().some((track) => !track.muted)), null, { timeout: 15000 })));
    await sharer.getByRole("button", { name: "Stop share", exact: true }).click();
    await sharer.getByRole("button", { name: "Share", exact: true }).waitFor({ timeout: 10000 });
    if (camera) assert.ok(await sharer.evaluate((id) => window.__lumaPeers[0].getSenders().some((sender) => sender.track?.id === id), camera), "camera restored after screen share");

    await caller.getByRole("button", { name: "Mute", exact: true }).click();
    assert.ok(await caller.evaluate(() => window.__lumaPeers[0].getSenders().find((sender) => sender.track?.kind === "audio")?.track.enabled === false), "mute disables the microphone track");
    await caller.getByRole("button", { name: "End", exact: true }).click();
    await caller.getByRole("dialog", { name: "Active call" }).waitFor({ state: "hidden", timeout: 10000 });
    if (group) {
      await Promise.all(recipients.map((page) => page.getByRole("dialog", { name: "Active call" }).waitFor({ state: "visible", timeout: 10000 })));
      await Promise.all(recipients.map((page) => page.waitForFunction(() => window.__lumaPeers.filter((pc) => pc.connectionState === "connected").length === 1 && window.__lumaPeers.some((pc) => pc.connectionState === "closed"), null, { timeout: 10000 })));
      await recipients[0].getByRole("button", { name: "End", exact: true }).click();
    }
    await Promise.all(recipients.map((page) => page.getByRole("dialog", { name: "Active call" }).waitFor({ state: "hidden", timeout: 10000 })));
    for (const signal of ["offer", "answer", "ice"]) assert.ok(events.some((event) => event.table === "call_signals" && event.kind === signal), `${signal} was exchanged`);
    assert.deepEqual(errors, []);
    console.log(`PASS: ${group ? "three-person audio mesh, reordered participant snapshot and screen share" : "direct video and screen share"}; lost signaling response retried (mock Supabase)`);
  } catch (error) {
    console.error("Browser call smoke test failed:", { calls, participants, recentEvents: events.slice(-12), errors });
    if (process.env.GITHUB_ACTIONS) {
      const message = `${group ? "Group" : "Direct"} call: ${error.message}`.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      console.log(`::error title=WebRTC browser smoke test::${message}`);
    }
    for (const page of pages) console.error("Visible UI:", (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).slice(-1000));
    throw error;
  } finally {
    releaseStale();
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
    await Promise.all(browsers.map((browser) => browser.close().catch(() => {})));
  }
}

try { await runScenario(false); await runScenario(true); }
finally { await new Promise((resolve) => server.close(resolve)); }
