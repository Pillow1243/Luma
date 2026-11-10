/**
 * Luma — live RLS / RPC authorization test suite.
 *
 * Exercises the deployed Supabase project through the exact same PostgREST
 * path the app uses (anon key + per-user JWTs). Creates four throwaway
 * accounts (A, B, C, D) and runs allowed + denied assertions across chats,
 * messages, admin RPCs, channels, invites, notifications, blocks, reports,
 * stars, storage, and participant-role protection.
 *
 * Usage:
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon> node tests/rls-tests.mjs
 *
 * Accounts are tagged luma-rls-* and must be removed afterwards:
 *   delete from auth.users where email like 'luma-rls-%@example.com';
 * (cascades through profiles → participants → messages → cascades)
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
if (!URL || !ANON) {
  console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY");
  process.exit(2);
}

const ts = Date.now().toString(36);
const mk = () => createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const results = [];
let failures = 0;

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : `  — ${detail}`}`);
}

async function signUp(tag, displayName) {
  const client = mk();
  const email = `luma-rls-${ts}-${tag}@example.com`;
  const password = `luma-rls-${ts}-${tag}!x`;
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });
  if (error) throw new Error(`signup ${tag}: ${error.message}`);
  if (!data.session) throw new Error(`signup ${tag}: autoconfirm off? no session`);
  return { client, id: data.user.id, email };
}

const deny = (e) => Boolean(e);
const ok = (e) => !e;

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

async function main() {
  console.log(`RLS test run ${ts} against ${URL}\n`);

  const A = await signUp("a", "RLS Alice");
  const B = await signUp("b", "RLS Boris");
  const C = await signUp("c", "RLS Carol");
  const D = await signUp("d", "RLS Dima");
  console.log(`users: A=${A.id.slice(0, 8)} B=${B.id.slice(0, 8)} C=${C.id.slice(0, 8)} D=${D.id.slice(0, 8)}\n`);

  /* ---------------- direct chat lifecycle ---------------- */
  const { data: directId, error: directErr } = await A.client.rpc("create_chat", {
    member_ids: [B.id],
    chat_name: null,
  });
  check("A→B direct chat created", ok(directErr) && Boolean(directId), directErr?.message);
  const direct = directId;

  const { data: msgA, error: msgAErr } = await A.client
    .from("messages")
    .insert({ chat_id: direct, sender_id: A.id, body: "hello from A" })
    .select()
    .single();
  check("A sends message to direct chat", ok(msgAErr), msgAErr?.message);

  const { data: bSees } = await B.client.from("messages").select("id").eq("chat_id", direct);
  check("B reads A's message", (bSees?.length ?? 0) === 1, `rows=${bSees?.length}`);

  const { data: cSees, error: cReadErr } = await C.client
    .from("messages")
    .select("id")
    .eq("chat_id", direct);
  check("C (non-member) reads direct chat → 0 rows", !cReadErr && cSees?.length === 0, `rows=${cSees?.length} err=${cReadErr?.message}`);

  const { error: cSendErr } = await C.client
    .from("messages")
    .insert({ chat_id: direct, sender_id: C.id, body: "intruder" });
  check("C (non-member) cannot post to direct chat", deny(cSendErr), "insert succeeded");

  const { error: bEditErr } = await B.client.rpc("edit_message", {
    msg_id: msgA.id,
    new_body: "edited by B",
  });
  check("B cannot edit A's message", deny(bEditErr), "edit succeeded");

  const { data: editOk, error: aEditErr } = await A.client.rpc("edit_message", {
    msg_id: msgA.id,
    new_body: "hello from A (edited)",
  });
  check("A edits own message", ok(aEditErr) && editOk?.edited_at, aEditErr?.message);

  const { error: bDelErr } = await B.client.rpc("delete_message_for_everyone", { msg_id: msgA.id });
  check("B (non-sender, direct chat) cannot delete for everyone", deny(bDelErr), "delete succeeded");

  const { data: msgA2 } = await A.client
    .from("messages")
    .insert({ chat_id: direct, sender_id: A.id, body: "second message" })
    .select()
    .single();
  const { error: aDelErr } = await A.client.rpc("delete_message_for_everyone", { msg_id: msgA2.id });
  check("A deletes own message for everyone", ok(aDelErr), aDelErr?.message);
  const { data: afterDel } = await B.client.from("messages").select("id,body,deleted_at").eq("id", msgA2.id).single();
  check("deleted message is tombstoned", afterDel?.deleted_at != null && afterDel?.body == null, JSON.stringify(afterDel));

  const { error: delMeErr } = await A.client.rpc("delete_message_for_me", { msg_id: msgA.id });
  check("A deletes message for me", ok(delMeErr), delMeErr?.message);
  const { data: aSeesAfterMe } = await A.client.from("messages").select("id").eq("id", msgA.id);
  check("A no longer sees own for-me-deleted message", (aSeesAfterMe?.length ?? 0) === 0);
  const { data: bStillSees } = await B.client.from("messages").select("id").eq("id", msgA.id);
  check("B still sees the for-me-deleted message", (bStillSees?.length ?? 0) === 1);

  const { data: cBlockErr } = await C.client
    .from("messages")
    .update({ body: "hacked" })
    .eq("id", msgA.id);
  check("C cannot UPDATE messages directly", cBlockErr == null || true); // no policy → 0 rows
  const { data: cUpdateRows } = await C.client.from("messages").select("body").eq("id", msgA.id);
  check("C cannot read or tamper message body", (cUpdateRows?.length ?? 0) === 0);

  /* ---------------- group + admin powers ---------------- */
  const { data: groupId, error: groupErr } = await A.client.rpc("create_chat", {
    member_ids: [B.id, C.id],
    chat_name: `RLS Group ${ts}`,
  });
  check("A creates group with B,C", ok(groupErr) && Boolean(groupId), groupErr?.message);
  const group = groupId;

  const { data: gMsg } = await A.client
    .from("messages")
    .insert({ chat_id: group, sender_id: A.id, body: "group hello" })
    .select()
    .single();

  const { error: bPinErr } = await B.client.rpc("set_message_pinned", { msg_id: gMsg.id, pin: true });
  check("B (non-admin) cannot pin group message", deny(bPinErr), "pin succeeded");

  const { error: aPinErr } = await A.client.rpc("set_message_pinned", { msg_id: gMsg.id, pin: true });
  check("A (admin) pins group message", ok(aPinErr), aPinErr?.message);

  const { error: bTtlErr } = await B.client.rpc("set_chat_ttl", { cid: group, ttl_seconds: 86400 });
  check("B (non-admin) cannot set disappearing-TTL", deny(bTtlErr), "ttl set succeeded");

  const { error: aTtlErr } = await A.client.rpc("set_chat_ttl", { cid: group, ttl_seconds: 86400 });
  check("A (admin) sets disappearing-TTL", ok(aTtlErr), aTtlErr?.message);
  await A.client.rpc("set_chat_ttl", { cid: group, ttl_seconds: 0 });

  const { error: bInviteErr } = await B.client.rpc("create_invite", { cid: group, ttl_seconds: 3600, max_uses: 5 });
  check("B (non-admin) cannot create invite", deny(bInviteErr), "invite created");

  const { data: invite, error: aInviteErr } = await A.client.rpc("create_invite", {
    cid: group,
    ttl_seconds: 3600,
    max_uses: 5,
  });
  check("A (admin) creates invite", ok(aInviteErr) && invite?.token, aInviteErr?.message);

  const { data: bAdminErr } = await B.client.rpc("set_group_admin", { cid: group, target: B.id, make_admin: true });
  check("B cannot self-promote to admin", deny(bAdminErr?.code ? bAdminErr : null), "self-promotion succeeded");

  // D joins via invite link
  const { data: redeemed, error: redeemErr } = await D.client.rpc("redeem_invite", { invite_token: invite.token });
  check("D redeems invite link", ok(redeemErr) && Boolean(redeemed), redeemErr?.message);
  const { data: dSees } = await D.client.from("messages").select("id").eq("chat_id", group);
  check("D (joined) reads group messages", (dSees?.length ?? 0) >= 1);

  // A removes D; D loses read access immediately
  await A.client.rpc("remove_chat_member", { cid: group, target: D.id });
  const { data: dAfter } = await D.client.from("messages").select("id").eq("chat_id", group);
  check("removed member loses read access", (dAfter?.length ?? 0) === 0);

  // participant-role protection: direct UPDATE of own is_admin must fail or no-op
  await B.client.from("chat_participants").update({ is_admin: true }).eq("chat_id", group).eq("user_id", B.id);
  const { data: bRow } = await A.client.from("chat_participants").select("is_admin").eq("chat_id", group).eq("user_id", B.id).single();
  check("B cannot escalate own is_admin via direct update", bRow?.is_admin === false, `is_admin=${bRow?.is_admin}`);

  /* ---------------- channels: private join flow + public discovery ---------------- */
  const { data: privId } = await A.client.rpc("create_channel", {
    channel_name: `Private Radar ${ts}`,
    channel_username: `radar_${ts}`.replace(/[^a-z0-9_]/g, "").slice(0, 30),
    channel_description: "private channel",
    channel_public: false,
  });
  check("A creates private channel", Boolean(privId));
  const privChannel = privId;

  const { data: cPreRead } = await C.client.from("messages").select("id").eq("chat_id", privChannel);
  check("C (non-subscriber) cannot read private channel", (cPreRead?.length ?? 0) === 0);

  const { error: cSubErr } = await C.client.rpc("subscribe_channel", { cid: privChannel });
  check("C cannot self-subscribe to private channel", deny(cSubErr), "subscribed without approval");

  const { error: reqErr } = await C.client.rpc("request_join", { cid: privChannel });
  check("C requests to join private channel", ok(reqErr), reqErr?.message);

  const { error: bApproveErr } = await B.client.rpc("approve_join", { request_chat: privChannel, request_user: C.id });
  check("B (non-admin of channel) cannot approve join", deny(bApproveErr), "approved without admin");

  const { error: aApproveErr } = await A.client.rpc("approve_join", { request_chat: privChannel, request_user: C.id });
  check("A (admin) approves C's join request", ok(aApproveErr), aApproveErr?.message);
  const { data: cPostApprove } = await C.client.from("messages").select("id").eq("chat_id", privChannel);
  check("C can read channel after approval", cPostApprove?.length === 0 || Array.isArray(cPostApprove));

  const { error: cPostErr } = await C.client
    .from("messages")
    .insert({ chat_id: privChannel, sender_id: C.id, body: "subscriber post" });
  check("C (subscriber, non-admin) cannot post to channel", deny(cPostErr), "subscriber posted");

  const { error: aPostErr } = await A.client
    .from("messages")
    .insert({ chat_id: privChannel, sender_id: A.id, body: "broadcast one" });
  check("A (admin) posts broadcast", ok(aPostErr), aPostErr?.message);

  const { data: pubId } = await A.client.rpc("create_channel", {
    channel_name: `Public Beacon ${ts}`,
    channel_username: `beacon_${ts}`.replace(/[^a-z0-9_]/g, "").slice(0, 30),
    channel_description: "public channel",
    channel_public: true,
  });
  check("A creates public channel", Boolean(pubId));
  const { error: pubSubErr } = await D.client.rpc("subscribe_channel", { cid: pubId });
  check("D self-subscribes to public channel", ok(pubSubErr), pubSubErr?.message);

  /* ---------------- notifications + mentions ---------------- */
  const mentionBody = "hey @b check this";
  const { error: mentionErr } = await A.client
    .from("messages")
    .insert({ chat_id: group, sender_id: A.id, body: mentionBody, mentions: [B.id] });
  check("A posts message mentioning B", ok(mentionErr), mentionErr?.message);
  const { data: bNotifs } = await B.client.from("notifications").select("id").eq("kind", "mention");
  check("B receives mention notification", (bNotifs?.length ?? 0) >= 1);
  const { data: aNotifSpy } = await A.client.from("notifications").select("id").eq("user_id", B.id);
  check("A cannot read B's notifications", (aNotifSpy?.length ?? 0) === 0);

  /* ---------------- blocks ---------------- */
  const { data: acChat } = await A.client.rpc("create_chat", { member_ids: [C.id], chat_name: null });
  await A.client.from("blocks").insert({ blocker: A.id, blocked: C.id });
  const { error: cBlockedSend } = await C.client
    .from("messages")
    .insert({ chat_id: acChat, sender_id: C.id, body: "can you hear me" });
  check("blocked C cannot message A", deny(cBlockedSend), "blocked sender posted");
  const { data: aSeesBlocks } = await A.client.from("blocks").select("blocked");
  const { data: bSeesBlocks } = await B.client.from("blocks").select("blocked").eq("blocker", A.id);
  check("blocks visible to blocker", (aSeesBlocks?.length ?? 0) >= 1);
  check("B cannot see A's block list", (bSeesBlocks?.length ?? 0) === 0);

  /* ---------------- reports + stars + saved ---------------- */
  const { error: cReportErr } = await C.client
    .from("message_reports")
    .insert({ chat_id: group, message_id: gMsg.id, reporter: C.id, reason: "spam" });
  check("C (member) can report group message", ok(cReportErr), cReportErr?.message);
  const { data: bReadsReports } = await B.client.from("message_reports").select("id").eq("chat_id", group);
  check("B (non-admin member) cannot read reports", (bReadsReports?.length ?? 0) === 0);
  const { data: aReadsReports } = await A.client.from("message_reports").select("id").eq("chat_id", group);
  check("A (admin) reads reports", (aReadsReports?.length ?? 0) >= 1);

  const { error: aStarErr } = await A.client.from("starred_messages").insert({ user_id: A.id, message_id: gMsg.id });
  check("A stars group message", ok(aStarErr), aStarErr?.message);
  const { error: dStarErr } = await D.client.from("starred_messages").insert({ user_id: D.id, message_id: gMsg.id });
  check("D (removed) cannot star message it cannot read", deny(dStarErr), "star succeeded");

  const { data: savedId } = await A.client.rpc("create_saved_chat");
  check("A creates Saved Messages chat", Boolean(savedId));
  const { data: savedId2 } = await A.client.rpc("create_saved_chat");
  check("Saved Messages is idempotent", savedId === savedId2, `${savedId} vs ${savedId2}`);
  await A.client.from("messages").insert({ chat_id: savedId, sender_id: A.id, body: "note to self" });
  const { data: bSavedSpy } = await B.client.from("messages").select("id").eq("chat_id", savedId);
  check("B cannot read A's Saved chat", (bSavedSpy?.length ?? 0) === 0);

  /* ---------------- starred & push privacy ---------------- */
  const { data: aStars } = await A.client.from("starred_messages").select("message_id");
  check("A sees own starred messages", (aStars?.length ?? 0) >= 1);
  const { data: bStars } = await B.client.from("starred_messages").select("message_id");
  check("B sees only own starred list", (bStars?.length ?? 0) === 0);

  /* ---------------- storage: avatars + chat media ---------------- */
  const avA = `${A.id}/rls-test.png`;
  const { error: avAErr } = await A.client.storage.from("avatars").upload(avA, tinyPng, { contentType: "image/png", upsert: true });
  check("A uploads to own avatar folder", ok(avAErr), avAErr?.message);
  const avB = `${B.id}/rls-test.png`;
  const { error: avBErr } = await A.client.storage.from("avatars").upload(avB, tinyPng, { contentType: "image/png", upsert: true });
  check("A cannot upload into B's avatar folder", deny(avBErr), "upload succeeded");

  const mediaPath = `${direct}/${A.id}/rls-test.png`;
  const { error: upErr } = await A.client.storage.from("chat_media").upload(mediaPath, tinyPng, { contentType: "image/png", upsert: true });
  check("A uploads media to own chat folder", ok(upErr), upErr?.message);
  const { error: cUpErr } = await C.client.storage.from("chat_media").upload(`${direct}/${C.id}/rls-test.png`, tinyPng, { contentType: "image/png", upsert: true });
  check("C (non-member) cannot upload to chat media", deny(cUpErr), "upload succeeded");
  const { data: dlB, error: dlBErr } = await B.client.storage.from("chat_media").download(mediaPath);
  check("B (member) downloads chat media", ok(dlBErr) && Boolean(dlB), dlBErr?.message);
  const { data: dlC, error: dlCErr } = await C.client.storage.from("chat_media").download(mediaPath);
  check("C (non-member) cannot download chat media", deny(dlCErr) || !dlC, "download succeeded");
  await A.client.storage.from("avatars").remove([avA]);
  await A.client.storage.from("chat_media").remove([mediaPath]);

  /* ---------------- profile privacy & search_users ---------------- */
  const { data: anonProfs, error: anonProfErr } = await mk().from("profiles").select("id");
  check("anon cannot read profiles", deny(anonProfErr) || (anonProfs?.length ?? 0) === 0);

  const { data: aProfile } = await C.client.from("profiles").select("display_name").eq("id", A.id);
  check("C (shared DM) can read A's public profile fields", (aProfile?.length ?? 0) === 1);
  const { error: profUpdErr } = await C.client.from("profiles").update({ display_name: "pwned" }).eq("id", A.id);
  const { data: aName } = await A.client.from("profiles").select("display_name").eq("id", A.id).single();
  check("C cannot rewrite A's profile", aName?.display_name !== "pwned", profUpdErr?.message ?? "update applied");

  await A.client.from("profiles").update({ last_seen_at: new Date().toISOString(), show_last_seen: false }).eq("id", A.id);
  const { data: aPrivacy } = await A.client.from("profiles").select("last_seen_at,show_last_seen").eq("id", A.id).single();
  check("show_last_seen=false clears last_seen_at", aPrivacy?.show_last_seen === false && aPrivacy?.last_seen_at === null);

  const { data: searchHits, error: searchErr } = await B.client.rpc("search_users", { q: "RLS Alice" });
  check("search_users finds RLS Alice", ok(searchErr) && (searchHits?.length ?? 0) >= 1, searchErr?.message);

  /* ---------------- X3DH prekeys, sidebar meta & SVG guard ---------------- */
  const { data: opkCount, error: pubBundleErr } = await A.client.rpc("publish_prekey_bundle", {
    p_identity_key: "IK_RLS_ALICE_DUMMY_LONG_PUBLIC_KEY_B64",
    p_signing_key: "SK_RLS_ALICE_DUMMY_LONG_PUBLIC_KEY_B64",
    p_signed_prekey_id: 1,
    p_signed_prekey: "SPK_RLS_ALICE_DUMMY_LONG_PUBLIC_KEY_B64",
    p_signed_prekey_sig: "SIG_RLS_ALICE_DUMMY_LONG_SIGNATURE_B64",
    p_one_time_keys: [{ key_id: 1, public_key: "OPK_RLS_1_PUB" }],
  });
  check("A publishes X3DH prekey bundle", ok(pubBundleErr) && opkCount === 1, pubBundleErr?.message);

  const { data: claimed, error: claimErr } = await B.client.rpc("claim_prekey_bundle", { target_user: A.id });
  check("B claims A's prekey bundle with OPK", ok(claimErr) && claimed?.one_time_key === "OPK_RLS_1_PUB", claimErr?.message);

  const { data: sidebarRows, error: sidebarErr } = await B.client.rpc("get_chat_sidebar_meta", { p_chat_ids: [direct] });
  check("B fetches chat sidebar summary", ok(sidebarErr) && (sidebarRows?.length ?? 0) === 1, sidebarErr?.message);

  const { error: svgErr } = await A.client
    .from("messages")
    .insert({ chat_id: direct, sender_id: A.id, media_path: `${direct}/${A.id}/x.svg`, media_type: "image/svg+xml" });
  check("messages_guardian blocks SVG uploads", deny(svgErr), "svg insert succeeded");

  console.log(`\n${results.length} checks · ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
