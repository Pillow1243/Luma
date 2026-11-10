/**
 * Luma — anonymous poll realtime sync integration test.
 *
 * Regression test for the bug where other chat members never saw an
 * anonymous poll's results update live. Root cause: the client subscribed
 * to postgres_changes on `poll_votes`, but Realtime enforces each
 * subscriber's own RLS before delivering an event, and the
 * `poll_votes_read` policy only lets a member see their OWN vote row on an
 * anonymous poll — so another member's INSERT was silently dropped for
 * everyone else. Fix: an identity-free aggregate table `poll_vote_counts`,
 * readable by every chat member regardless of anonymity, maintained by a
 * trigger and added to the `supabase_realtime` publication. The client now
 * subscribes to that table instead (src/components/Poll.tsx).
 * See supabase/migrations/20261110123641_luma_poll_realtime_fix.sql.
 *
 * This test exercises the exact same path the app uses: anon key + two
 * per-user JWTs, a real websocket Realtime subscription, and the
 * create_luma_poll / vote_luma_poll / get_poll_results RPCs. It:
 *   1. Signs up two throwaway accounts A and B and puts them in a group chat.
 *   2. A creates an ANONYMOUS poll.
 *   3. B opens a postgres_changes subscription on poll_vote_counts filtered
 *      to that poll (mirroring Poll.tsx).
 *   4. A votes.
 *   5. Asserts B's subscription actually receives a change event (proving
 *      realtime sync works for anonymous polls for a non-voting member),
 *      and that get_poll_results() reflects the vote for B.
 *   6. Asserts B's direct `poll_votes` select for that poll returns zero
 *      rows — ballot secrecy is preserved; only the aggregate is visible.
 *
 * Usage:
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon> node tests/poll-realtime-tests.mjs
 *
 * Accounts are tagged luma-rls-* and must be removed afterwards:
 *   delete from auth.users where email like 'luma-rls-%@example.com';
 * (cascades through profiles → participants → chats/messages/polls)
 *
 * KNOWN LIMITATION: this file has NOT been executed from the agent sandbox
 * used to develop this fix — that sandbox has no outbound network access to
 * *.supabase.co (same limitation already tracked under Linear issue
 * JHE-10). The RLS and trigger behavior this test exercises WAS
 * independently verified directly against the live production database
 * using a role/JWT-claim SQL simulation technique (set local role
 * authenticated; set local request.jwt.claim.sub = '<uuid>') run through
 * the Supabase connector's execute_query tool — see the delivery report for
 * the exact queries and results. That technique validates the Postgres-side
 * RLS/trigger correctness, but NOT the websocket delivery path itself,
 * which only this file (run from an environment with real network access)
 * can confirm end-to-end. Run this file from such an environment before
 * relying on it as end-to-end proof.
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

function waitForEvent(channel, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(null); }
    }, timeoutMs);
    channel._lumaTestResolve = (payload) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(payload);
      }
    };
  });
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

const ok = (e) => !e;

async function main() {
  console.log(`Poll realtime test run ${ts} against ${URL}\n`);

  const A = await signUp("prt-a", "PollRT Alice");
  const B = await signUp("prt-b", "PollRT Boris");
  console.log(`users: A=${A.id.slice(0, 8)} B=${B.id.slice(0, 8)}\n`);

  const { data: chatId, error: chatErr } = await A.client.rpc("create_chat", {
    member_ids: [B.id],
    chat_name: "Poll RT test chat",
  });
  check("A creates a shared chat with B", ok(chatErr) && Boolean(chatId), chatErr?.message);

  const { data: messageId, error: pollErr } = await A.client.rpc("create_luma_poll", {
    cid: chatId,
    poll_question: "Does realtime sync work for anonymous polls?",
    poll_options: ["Yes", "No"],
    p_allow_multiple: false,
    p_anonymous: true,
    p_closes_in_seconds: null,
  });
  check("A creates an anonymous poll", ok(pollErr) && Boolean(messageId), pollErr?.message);

  const { data: pollRow, error: pollRowErr } = await B.client
    .from("polls")
    .select("id")
    .eq("message_id", messageId)
    .maybeSingle();
  check("B can see the poll row", ok(pollRowErr) && Boolean(pollRow?.id), pollRowErr?.message);
  const pollId = pollRow?.id;

  const { data: optionRows, error: optErr } = await B.client
    .from("poll_options")
    .select("id,label")
    .eq("poll_id", pollId)
    .order("position");
  check("B can see poll options", ok(optErr) && (optionRows?.length ?? 0) === 2, optErr?.message);
  const yesOption = optionRows?.find((o) => o.label === "Yes");

  // B subscribes exactly like Poll.tsx does post-fix: postgres_changes on
  // poll_vote_counts, filtered to this poll.
  const channel = B.client
    .channel(`luma:poll:${pollId}:${crypto.randomUUID()}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "poll_vote_counts", filter: `poll_id=eq.${pollId}` },
      (payload) => { channel._lumaTestResolve?.(payload); }
    )
    .subscribe();

  // give the subscription a moment to establish before A votes
  await new Promise((r) => setTimeout(r, 1500));

  const eventPromise = waitForEvent(channel, 15000);
  const { error: voteErr } = await A.client.rpc("vote_luma_poll", { poll_uuid: pollId, option_uuid: yesOption?.id });
  check("A casts a vote on the anonymous poll", ok(voteErr), voteErr?.message);

  const event = await eventPromise;
  check(
    "B (non-voter) receives a realtime change event on poll_vote_counts after A's anonymous vote",
    Boolean(event),
    "no postgres_changes event received within 15s — this is the regression this fix addresses"
  );
  await B.client.removeChannel(channel);

  const { data: resultsForB, error: resultsErr } = await B.client.rpc("get_poll_results", { poll_uuid: pollId });
  const yesResult = resultsForB?.find((r) => r.option_id === yesOption?.id);
  check(
    "B's get_poll_results reflects A's vote (count=1)",
    ok(resultsErr) && yesResult?.votes === 1,
    resultsErr?.message ?? `votes=${yesResult?.votes}`
  );

  const { data: bVisibleVotes, error: bVotesErr } = await B.client
    .from("poll_votes")
    .select("option_id,user_id")
    .eq("poll_id", pollId);
  check(
    "B cannot see A's individual ballot row (anonymity preserved)",
    ok(bVotesErr) && (bVisibleVotes?.length ?? 0) === 0,
    bVotesErr?.message ?? `rows visible=${bVisibleVotes?.length}`
  );

  console.log(`\n${results.length} checks · ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
