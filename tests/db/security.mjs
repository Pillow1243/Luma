#!/usr/bin/env node
/**
 * Luma — multi-user authorization suite (RLS / RPC / Storage), runnable in CI.
 *
 * The repository previously had one authorization suite (tests/rls-tests.mjs)
 * that could only run by hand against the hosted project because it needs the
 * network + real GoTrue accounts. This suite executes the same class of
 * negative, cross-user assertions against a real PostgreSQL that has the
 * production schema and every migration applied, using Supabase-accurate
 * identity switching:
 *
 *     set local role authenticated;
 *     set local config request.jwt.claims = '{"sub":"<user>","role":"authenticated"}';
 *
 * so `auth.uid()` inside RLS policies and SECURITY DEFINER functions resolves
 * exactly as it does on Supabase. No mocks are involved in the authorization
 * path.
 *
 * Usage: DATABASE_URL=postgresql://... node tests/db/security.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const baselineDir = join(repo, "supabase", "baseline");
const migrationsDir = join(repo, "supabase", "migrations");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required (see scripts/dev-postgres.md)");
  process.exit(2);
}

const DB = "luma_security";

/* ------------------------------------------------------------------ setup -- */

/** Every client handed out, so teardown never drops a database under a socket. */
const liveClients = new Set();

async function adminClient(db = DB) {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${db}`;
  const c = new pg.Client({ connectionString: url.toString() });
  // Connection-level errors (e.g. the server going away) must not surface as
  // unhandled event-emitter crashes; the suite reports failures per scenario.
  c.on("error", () => {});
  await c.connect();
  liveClients.add(c);
  const end = c.end.bind(c);
  c.end = async (...args) => {
    liveClients.delete(c);
    return end(...args);
  };
  return c;
}

async function closeAllClients() {
  for (const c of [...liveClients]) {
    try { await c.end(); } catch { /* already gone */ }
  }
}

async function rebuild() {
  const admin = new URL(DATABASE_URL);
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(
    `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`,
    [DB]
  );
  await c.query(`drop database if exists ${pg.escapeIdentifier(DB)}`);
  await c.query(`create database ${pg.escapeIdentifier(DB)}`);
  await c.end();

  const client = await adminClient();
  const hasExt = async (name) => {
    const r = await client.query(
      `select 1 from pg_available_extensions where name=$1`, [name]
    );
    return r.rowCount > 0;
  };
  const transform = async (sql) => {
    let out = sql;
    if (!(await hasExt("citext"))) out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+citext\s*;/gi, "");
    if (!(await hasExt("pgcrypto"))) out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+pgcrypto\s*;/gi, "");
    if (!(await hasExt("pg_trgm"))) {
      out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+pg_trgm[^;]*;/gi, "create schema if not exists extensions;");
      out = out.replace(/create\s+index[^;]*?gin_trgm_ops[^;]*;/gis, "");
    }
    if (!(await hasExt("pg_cron"))) out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+pg_cron\s*;/gi, "");
    return out;
  };

  const files = [
    join(baselineDir, "00_platform_shim.sql"),
    join(baselineDir, "01_production_schema.sql"),
    join(baselineDir, "02_production_grants.sql"),
    ...readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => join(migrationsDir, f)),
  ];
  for (const f of files) {
    await client.query(await transform(readFileSync(f, "utf8")));
  }
  return client;
}

/* ------------------------------------------------------------ fixtures ---- */

const U = {
  alice: "11111111-1111-4111-8111-111111111111",
  boris: "22222222-2222-4222-8222-222222222222",
  carol: "33333333-3333-4333-8333-333333333333",
  dave: "44444444-4444-4444-8444-444444444444",
};

let F = {};


/**
 * Structural rows (users, chats, memberships, messages, storage objects) are
 * created by the table owner (`postgres`), exactly like a real seeding job.
 * Anything a trigger or policy validates against `auth.uid()` is created
 * under the identity of the user it belongs to, so the fixture never relies on
 * bypassing a guard that exists in production.
 */
async function seed(db) {
  for (const [name, id] of Object.entries(U)) {
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
      [id, `${name}@luma.test`, JSON.stringify({ display_name: name[0].toUpperCase() + name.slice(1) })]
    );
  }

  const one = async (sql, params = []) => {
    try {
      const st = sql.replace(/\s+/g, " ").trim().slice(0, 90);
      return (await db.query(`/* ${st} */ ${sql}`, params)).rows[0];
    } catch (err) {
      err.message = `${err.message} [in fixture: ${sql.replace(/\s+/g, " ").slice(0, 120)}]`;
      throw err;
    }
  };

  /** Run a block of statements inside a transaction authenticated as `userId`. */
  const as = async (userId, fn) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      if (process.env.SEC_DEBUG) {
        const d = await db.query(
          `select has_schema_privilege(current_user,'storage','usage') as u,
                  has_table_privilege(current_user,'storage.objects','insert') as i,
                  current_user as cu, current_setting('search_path') as sp`
        );
        console.error("debug", JSON.stringify(d.rows[0]));
      }
      const out = await fn();
      await db.query("commit");
      void out;
      return out;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  };

  // A direct chat between Alice and Boris.
  F.direct = (await one(
    `insert into chats (kind, is_group, created_by) values ('direct', false, $1) returning id`,
    [U.alice]
  )).id;
  await db.query(
    `insert into chat_participants (chat_id, user_id, is_admin) values
       ($1, $2, false), ($1, $3, false)`,
    [F.direct, U.alice, U.boris]
  );

  // A third user's private direct chat, Alice must not see it.
  F.strangerDirect = (await one(
    `insert into chats (kind, is_group, created_by) values ('direct', false, $1) returning id`,
    [U.carol]
  )).id;
  await db.query(
    `insert into chat_participants (chat_id, user_id, is_admin) values ($1,$2,false),($1,$3,false)`,
    [F.strangerDirect, U.carol, U.dave]
  );

  // A second direct chat, Carol <-> Dave, so Carol shares a chat with Dave only.
  // Alice's group (she is admin), Boris is a plain member, Carol is not a member.
  F.group = (await one(
    `insert into chats (name, kind, is_group, created_by) values ('Team', 'group', true, $1) returning id`,
    [U.alice]
  )).id;
  await db.query(
    `insert into chat_participants (chat_id, user_id, is_admin) values ($1,$2,true),($1,$3,false)`,
    [F.group, U.alice, U.boris]
  );

  // A public channel owned by Boris (so Alice is a subscriber, not an admin).
  F.publicChannel = (await one(
    `insert into chats (name, kind, is_group, created_by, username, is_public)
     values ('News', 'channel', false, $1, 'luma_news', true) returning id`,
    [U.boris]
  )).id;
  await db.query(
    `insert into chat_participants (chat_id, user_id, is_admin) values ($1,$2,true),($1,$3,false)`,
    [F.publicChannel, U.boris, U.alice]
  );

  // A private (invite-only) channel owned by Boris; Alice is not a member.
  F.privateChannel = (await one(
    `insert into chats (name, kind, is_group, created_by, username, is_public)
     values ('Secret Club', 'channel', false, $1, 'luma_secret', false) returning id`,
    [U.boris]
  )).id;
  await db.query(
    `insert into chat_participants (chat_id, user_id, is_admin) values ($1,$2,true)`,
    [F.privateChannel, U.boris]
  );

  // Messages — inserted as their author so messages_guardian() runs for real.
  await as(U.alice, async () => {
    F.aliceMessage = (await one(
      `insert into messages (chat_id, sender_id, body) values ($1,$2,'hello boris') returning id`,
      [F.direct, U.alice]
    )).id;
  });
  await as(U.boris, async () => {
    F.borisMessage = (await one(
      `insert into messages (chat_id, sender_id, body) values ($1,$2,'hi alice') returning id`,
      [F.direct, U.boris]
    )).id;
    F.channelMessage = (await one(
      `insert into messages (chat_id, sender_id, body) values ($1,$2,'broadcast') returning id`,
      [F.publicChannel, U.boris]
    )).id;
  });
  await as(U.carol, async () => {
    F.strangerMessage = (await one(
      `insert into messages (chat_id, sender_id, body) values ($1,$2,'private plan') returning id`,
      [F.strangerDirect, U.carol]
    )).id;
  });

  // A poll created by Alice in her own group, through the real RPC.
  await as(U.alice, async () => {
    F.pollMessage = (await one(`select public.create_luma_poll($1,$2,$3) as mid`, [
      F.group,
      "lunch?",
      ["pizza", "sushi"],
    ])).mid;
  });
  F.poll = (await one(`select id from polls where message_id=$1`, [F.pollMessage])).id;
  F.option = (await one(
    `select id from poll_options where poll_id=$1 order by "position" limit 1`,
    [F.poll]
  )).id;

  // Storage objects are inserted by their owner (storage RLS is per-user).
  const upload = (userId, bucket, path) =>
    as(userId, () =>
      one(`insert into storage.objects (bucket_id, name, owner) values ($1,$2,$3) returning id`, [
        bucket,
        path,
        userId,
      ])
    );
  await upload(U.alice, "chat_media", `${F.direct}/${U.alice}/photo.png`);
  await upload(U.carol, "chat_media", `${F.strangerDirect}/${U.carol}/secret.png`);
  await upload(U.carol, "avatars", `${U.carol}/avatar.png`);

  // Push subscriptions are created through the RPC the client uses.
  await as(U.alice, () =>
    db.query(`select public.register_push_subscription($1,$2,$3)`, [
      "https://push.example/alice-abcdefghij",
      "p256dh-key-alice-1234",
      "auth-alice-1",
    ])
  );
  await as(U.carol, () =>
    db.query(`select public.register_push_subscription($1,$2,$3)`, [
      "https://push.example/carol-abcdefghij",
      "p256dh-key-carol-1234",
      "auth-carol-1",
    ])
  );
}

/* --------------------------------------------------- assertion framework -- */

const results = [];
async function scenario(db, label, fn) {
  const client = await adminClient();
  let ok = false;
  let detail = "";
  try {
    await client.query("begin");
    ok = await fn(client);
  } catch (err) {
    ok = false;
    detail = err.message;
  } finally {
    try { await client.query("rollback"); } catch { /* ignore */ }
    await client.end();
  }
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  — ${detail}`}`);
}

/** Switch the transaction to a specific end user (Supabase semantics). */
async function as(client, userId, role = "authenticated") {
  await client.query(`set local role ${role}`);
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role }),
  ]);
}

async function asAnon(client) {
  await client.query("set local role anon");
  await client.query(`select set_config('request.jwt.claims', '', true)`);
}

/** The statement must fail (RLS denial, exception, or missing privilege). */
async function denied(client, sql, params = []) {
  try {
    await client.query("savepoint p");
    await client.query(sql, params);
    await client.query("release savepoint p");
    return false;
  } catch {
    await client.query("rollback to savepoint p");
    return true;
  }
}

/** The statement must succeed AND affect/return what we expect. */
async function allowed(client, sql, params = []) {
  try {
    await client.query("savepoint p");
    const res = await client.query(sql, params);
    await client.query("release savepoint p");
    return res;
  } catch (err) {
    await client.query("rollback to savepoint p");
    throw err;
  }
}

const empty = (res) => res.rowCount === 0;

/* ------------------------------------------------------------- scenarios -- */

async function main() {
  const setup = await rebuild();
  await seed(setup);
  await setup.end();
  const openClients = [];

  const db = () => adminClient();
  /** Table-owner connection, for fixture rows that clients cannot insert. */
  const owner = () => adminClient();
  /**
   * Owner connection impersonating a user without dropping privileges: the row
   * is written as the table owner (so grants are irrelevant) while
   * `auth.uid()`-based trigger logic still sees the real user, exactly like a
   * maintenance job that runs as postgres with a JWT context.
   */
  const ownerAs = async (userId) => {
    const c = await adminClient();
    await c.query(`select set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    return c;
  };

  /* ---------------- 1. read isolation across users (IDOR) ---------------- */

  await scenario(db, "Alice reads her own message", (c) =>
    as(c, U.alice).then(async () => {
      const r = await allowed(c, `select id from messages where id=$1`, [F.aliceMessage]);
      return r.rowCount === 1;
    }));

  await scenario(db, "Alice cannot read Boris' private chat messages", (c) =>
    as(c, U.alice).then(async () => {
      const r = await allowed(c, `select id from messages where id=$1`, [F.strangerMessage]);
      return empty(r);
    }));

  await scenario(db, "Alice cannot read Boris' private chat row", (c) =>
    as(c, U.alice).then(async () => {
      const r = await allowed(c, `select id from chats where id=$1`, [F.strangerDirect]);
      return empty(r);
    }));

  await scenario(db, "Non-member cannot read a private channel", (c) =>
    as(c, U.alice).then(async () => {
      const r = await allowed(c, `select id from chats where id=$1`, [F.privateChannel]);
      return empty(r);
    }));

  await scenario(db, "Public channel metadata is discoverable", (c) =>
    as(c, U.dave).then(async () => {
      const r = await allowed(c, `select id from chats where id=$1`, [F.publicChannel]);
      return r.rowCount === 1;
    }));

  await scenario(db, "Anonymous role reads nothing at all", async (c) => {
    await asAnon(c);
    const tables = ["messages", "chats", "chat_participants", "profiles", "push_subscriptions",
                    "chat_invites", "join_requests", "notifications", "user_prekey_bundles"];
    for (const t of tables) {
      // Either the grant is missing (permission denied — the stronger outcome)
      // or RLS yields no rows. Both are acceptable; any row is a failure.
      const denied2 = await denied(c, `select * from public.${t} limit 1`);
      if (denied2) continue;
      if (!empty(await allowed(c, `select * from public.${t} limit 1`))) return false;
    }
    return true;
  });

  await scenario(db, "Stranger profile is not enumerable", (c) =>
    as(c, U.alice).then(async () => {
      const r = await allowed(c, `select id from profiles where id=$1`, [U.carol]);
      return empty(r);
    }));

  /* ---------------- 2. write isolation and spoofing ---------------------- */

  await scenario(db, "Cannot insert a message as another user", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into messages (chat_id, sender_id, body) values ($1,$2,'spoof')`, [
        F.direct,
        U.boris,
      ])));

  await scenario(db, "Cannot insert into a chat you do not belong to", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into messages (chat_id, sender_id, body) values ($1,$2,'intrude')`, [
        F.strangerDirect,
        U.alice,
      ])));

  await scenario(db, "Cannot forge server-controlled message columns", async (c) => {
    await as(c, U.alice);
    // deleted_at / edited_at / pinned_at are not even in the INSERT grant.
    if (!(await denied(c, `insert into messages (chat_id, sender_id, body, deleted_at) values ($1,$2,'x', now())`, [F.direct, U.alice]))) return false;
    // Columns that ARE granted are reset by messages_guardian before the row lands.
    const r = await allowed(
      c,
      `insert into messages (chat_id, sender_id, body, forwarded_from) values ($1,$2,'x',null) returning deleted_at, edited_at, pinned_at, deleted_for`,
      [F.direct, U.alice]
    );
    const row = r.rows[0];
    return row.deleted_at === null && row.edited_at === null && row.pinned_at === null &&
      JSON.stringify(row.deleted_for) === "[]";
  });

  await scenario(db, "Cannot point media_path at another user's folder", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into messages (chat_id, sender_id, body, media_path) values ($1,$2,'x',$3)`, [
        F.direct,
        U.alice,
        `${F.direct}/${U.boris}/stolen.png`,
      ])));

  await scenario(db, "Cannot reply to a message from another chat", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into messages (chat_id, sender_id, body, reply_to) values ($1,$2,'x',$3)`, [
        F.direct,
        U.alice,
        F.strangerMessage,
      ])));

  await scenario(db, "Reaction on a foreign message is rejected", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into message_reactions (message_id, user_id, emoji) values ($1,$2,'🔥')`, [
        F.strangerMessage,
        U.alice,
      ])));

  await scenario(db, "Reaction cannot be attributed to another user", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into message_reactions (message_id, user_id, emoji) values ($1,$2,'🔥')`, [
        F.aliceMessage,
        U.boris,
      ])));

  await scenario(db, "Starring a foreign message is rejected", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into starred_messages (user_id, message_id) values ($1,$2)`, [
        U.alice,
        F.strangerMessage,
      ])));

  await scenario(db, "Editing another user's message fails", (c) =>
    as(c, U.boris).then(() =>
      denied(c, `select public.edit_message($1,'hacked')`, [F.aliceMessage])));

  await scenario(db, "Deleting another user's message fails in a direct chat", (c) =>
    as(c, U.boris).then(() =>
      denied(c, `select public.delete_message_for_everyone($1)`, [F.aliceMessage])));

  /* ---------------- 3. privilege escalation ----------------------------- */

  await scenario(db, "Member cannot promote themselves to admin", (c) =>
    as(c, U.boris).then(() =>
      denied(c, `update chat_participants set is_admin = true where chat_id=$1 and user_id=$2`, [
        F.group,
        U.boris,
      ])));

  await scenario(db, "Member cannot change membership columns of a peer", (c) =>
    as(c, U.boris).then(() =>
      denied(c, `update chat_participants set is_admin = true where chat_id=$1 and user_id=$2`, [
        F.group,
        U.alice,
      ])));

  await scenario(db, "Non-admin cannot call set_group_admin", (c) =>
    as(c, U.boris).then(() =>
      denied(c, `select public.set_group_admin($1,$2,true)`, [F.group, U.boris])));

  await scenario(db, "Non-admin cannot add members", (c) =>
    as(c, U.boris).then(() => denied(c, `select public.add_chat_member($1,$2)`, [F.group, U.dave])));

  await scenario(db, "Stranger cannot self-add to a private group", (c) =>
    as(c, U.carol).then(() =>
      denied(c, `insert into chat_participants (chat_id, user_id) values ($1,$2)`, [F.group, U.carol])));

  await scenario(db, "Non-member cannot request to join a group via direct insert", (c) =>
    as(c, U.carol).then(() =>
      denied(c, `insert into join_requests (chat_id, user_id) values ($1,$2)`, [F.group, U.carol])));

  await scenario(db, "Non-admin cannot approve their own join request", (c) =>
    as(c, U.carol).then(async () => {
      await allowed(c, `select public.request_join($1)`, [F.group]);
      return denied(c, `select public.approve_join($1,$2)`, [F.group, U.carol]);
    }));

  await scenario(db, "Group creator cannot be removed (last owner protection)", (c) =>
    as(c, U.boris).then(async () => {
      // Boris is not admin; even an admin removal must protect created_by
      return denied(c, `select public.remove_chat_member($1,$2)`, [F.group, U.alice]);
    }));

  await scenario(db, "Admin cannot demote the chat creator", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `select public.set_group_admin($1,$2,false)`, [F.group, U.alice])));

  await scenario(db, "Roles cannot be escalated through a plain UPDATE by the owner", (c) =>
    as(c, U.boris).then(() =>
      denied(c, `update chat_participants set is_admin = true where user_id=$1`, [U.boris])));

  await scenario(db, "Subscriber cannot post into a channel", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into messages (chat_id, sender_id, body) values ($1,$2,'spam')`, [
        F.publicChannel,
        U.alice,
      ])));

  await scenario(db, "Non-admin cannot update channel metadata", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `select public.update_channel($1,'hijacked',null,null,null,null)`, [F.publicChannel])));

  await scenario(db, "Non-member cannot take over a private channel name", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `select public.update_channel($1,'x',null,'taken_name',null,null)`, [F.privateChannel])));

  await scenario(db, "Non-member cannot subscribe to a private channel", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `select public.subscribe_channel($1)`, [F.privateChannel])));

  await scenario(db, "Member cannot change disappearing-message TTL of a group", (c) =>
    as(c, U.boris).then(() => denied(c, `select public.set_chat_ttl($1,60)`, [F.group])));

  await scenario(db, "Stranger cannot change TTL of someone else's direct chat", (c) =>
    as(c, U.carol).then(() => denied(c, `select public.set_chat_ttl($1,60)`, [F.direct])));

  await scenario(db, "Direct chat columns (kind/created_by) are not client-writable", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `update chats set kind='channel', is_public=true where id=$1`, [F.direct])));

  await scenario(db, "A plain member cannot pin in a group they do not administer", (c) =>
    as(c, U.boris).then(async () => {
      const mid = await allowed(
        c,
        `insert into messages (chat_id, sender_id, body) values ($1,$2,'pin me?') returning id`,
        [F.group, U.boris]
      );
      return denied(c, `select public.set_message_pinned($1,true)`, [mid.rows[0].id]);
    }));

  await scenario(db, "A group admin can pin in their group", (c) =>
    as(c, U.alice).then(async () => {
      const mid = await allowed(
        c,
        `insert into messages (chat_id, sender_id, body) values ($1,$2,'announcement') returning id`,
        [F.group, U.alice]
      );
      await allowed(c, `select public.set_message_pinned($1,true)`, [mid.rows[0].id]);
      const r = await allowed(c, `select pinned_at from messages where id=$1`, [mid.rows[0].id]);
      return r.rows[0].pinned_at !== null;
    }));

  await scenario(db, "Secret-chat pinning is refused even for the sender", async (c) => {
    await as(c, U.alice);
    const secret = (await allowed(c, `select public.create_secret_chat($1, 300) as id`, [U.boris]))
      .rows[0].id;
    const mid = await allowed(
      c,
      `insert into messages (chat_id, sender_id, body) values ($1,$2,'ephemeral') returning id`,
      [secret, U.alice]
    );
    return denied(c, `select public.set_message_pinned($1,true)`, [mid.rows[0].id]);
  });

  await scenario(db, "Secret chat is created non-group with a TTL and both peers", async (c) => {
    await as(c, U.alice);
    const r = await allowed(c, `select public.create_secret_chat($1, 86400) as id`, [U.boris]);
    const id = r.rows[0].id;
    const meta = await allowed(c, `select is_secret, ttl_seconds, kind from chats where id=$1`, [id]);
    const members = await allowed(c, `select user_id from chat_participants where chat_id=$1`, [id]);
    const row = meta.rows[0];
    return row.is_secret === true && row.ttl_seconds === 86400 && row.kind === "direct" &&
      members.rowCount === 2;
  });

  /* ---------------- 4. invites ------------------------------------------ */

  await scenario(db, "Invite: non-admin cannot create one", (c) =>
    as(c, U.boris).then(() => denied(c, `select public.create_invite($1, 3600, 5)`, [F.group])));

  await scenario(db, "Invite: admin creates, stranger redeems once, reuse limit enforced", (c) =>
    as(c, U.alice).then(async () => {
      const inv = await allowed(c, `select (public.create_invite($1, 3600, 1)).token as token`, [F.group]);
      const token = inv.rows[0].token;
      await c.query("savepoint s1");
      await as(c, U.carol);
      const r1 = await allowed(c, `select public.redeem_invite($1)`, [token]);
      const joined = r1.rows[0].redeem_invite === F.group;
      await c.query("savepoint s2");
      const second = await denied(c, `select public.redeem_invite($1)`, [token]);
      await c.query("rollback to savepoint s2");
      return joined && second;
    }));

  await scenario(db, "Invite: revoked link cannot be redeemed", (c) =>
    as(c, U.alice).then(async () => {
      const inv = await allowed(c, `select (public.create_invite($1, 3600, 5)).token as token`, [F.group]);
      const token = inv.rows[0].token;
      await allowed(c, `select public.revoke_invite($1)`, [token]);
      await c.query("savepoint s3");
      await as(c, U.dave);
      return denied(c, `select public.redeem_invite($1)`, [token]);
    }));

  await scenario(db, "Invite: expired link cannot be redeemed", async (c) => {
    // chat_invites has no client INSERT grant, so the row is written the way a
    // maintenance job would write it, then redeemed as a real end user.
    const oc = await owner();
    const ins = await oc.query(
      `insert into chat_invites (chat_id, created_by, expires_at, max_uses)
       values ($1,$2, now() - interval '1 minute', 5) returning token`,
      [F.group, U.alice]
    );
    const token = ins.rows[0].token;
    await as(c, U.dave);
    return denied(c, `select public.redeem_invite($1)`, [token]);
  });

  await scenario(db, "Invite: usage limit is enforced, not just expires_at", async (c) => {
    const oc = await owner();
    const ins = await oc.query(
      `insert into chat_invites (chat_id, created_by, max_uses, uses) values ($1,$2,1,1) returning token`,
      [F.group, U.alice]
    );
    await as(c, U.dave);
    return denied(c, `select public.redeem_invite($1)`, [ins.rows[0].token]);
  });

  await scenario(db, "Invite: a member cannot read the invite table", (c) =>
    as(c, U.boris).then(async () => {
      const r = await allowed(c, `select token from chat_invites where chat_id=$1`, [F.group]);
      return empty(r);
    }));

  /* ---------------- 5. blocks / reports / push -------------------------- */

  await scenario(db, "Blocked peer's message is rejected by the server", (c) =>
    as(c, U.boris).then(async () => {
      await allowed(c, `insert into blocks (blocker, blocked) values ($1,$2)`, [U.boris, U.alice]);
      return denied(c, `insert into messages (chat_id, sender_id, body) values ($1,$2,'still there?')`, [
        F.direct,
        U.alice,
      ]);
    }));

  await scenario(db, "Cannot block on behalf of another user", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into blocks (blocker, blocked) values ($1,$2)`, [U.boris, U.carol])));

  await scenario(db, "Block rows are not readable by the blocked user", (c) =>
    as(c, U.alice).then(async () => {
      const r = await allowed(c, `select blocked from blocks`, []);
      return empty(r); // Alice has not blocked anyone; Boris' block must stay hidden
    }));

  await scenario(db, "Report requires membership of the reported chat", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into message_reports (chat_id, message_id, reporter, reason) values ($1,$2,$3,'spam')`, [
        F.strangerDirect,
        F.strangerMessage,
        U.alice,
      ])));

  await scenario(db, "Report cannot be attributed to another reporter", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into message_reports (chat_id, message_id, reporter, reason) values ($1,$2,$3,'spam')`, [
        F.direct,
        F.borisMessage,
        U.boris,
      ])));

  await scenario(db, "Reports are not readable by non-admin non-reporter", (c) =>
    as(c, U.boris).then(async () => {
      await c.query("savepoint r1");
      await as(c, U.alice);
      await allowed(c, `insert into message_reports (chat_id, message_id, reporter, reason) values ($1,$2,$3,'spam')`, [
        F.direct,
        F.borisMessage,
        U.alice,
      ]);
      await c.query("savepoint r2");
      await as(c, U.boris);
      const res = await allowed(c, `select id from message_reports where chat_id=$1`, [F.direct]);
      return empty(res);
    }));

  await scenario(db, "Cannot hijack another user's push endpoint", async (c) => {
    // Alice knows Carol's endpoint and tries to re-point it at herself.
    await as(c, U.alice);
    const refused = await denied(c, `select public.register_push_subscription($1,$2,$3)`, [
      "https://push.example/carol-abcdefghij",
      "p256dh-key-attacker-1234",
      "auth-attack-1",
    ]);
    const oc = await owner();
    const row = await oc.query(
      `select user_id, p256dh from push_subscriptions where endpoint=$1`,
      ["https://push.example/carol-abcdefghij"]
    );
    return refused && row.rows[0]?.user_id === U.carol &&
      row.rows[0]?.p256dh === "p256dh-key-carol-1234";
  });

  await scenario(db, "Re-registering your own endpoint rotates the keys", async (c) => {
    await as(c, U.alice);
    await allowed(c, `select public.register_push_subscription($1,$2,$3)`, [
      "https://push.example/alice-abcdefghij",
      "p256dh-key-alice-rotated",
      "auth-alice-2",
    ]);
    const r = await allowed(
      c,
      `select p256dh from push_subscriptions where endpoint=$1`,
      ["https://push.example/alice-abcdefghij"]
    );
    return r.rows[0]?.p256dh === "p256dh-key-alice-rotated";
  });

  await scenario(db, "Push subscriptions of others are invisible", (c) =>
    as(c, U.alice).then(async () => {
      const r = await allowed(c, `select endpoint from push_subscriptions`);
      return r.rows.every((row) => row.endpoint.includes("alice"));
    }));

  await scenario(db, "Push log is invisible and unwritable to clients", async (c) => {
    await as(c, U.alice);
    const read = await allowed(c, `select id from push_log limit 1`).then(
      (r) => r.rowCount,
      () => 0
    );
    if (read !== 0) return false;
    return denied(c, `insert into push_log (user_id, chat_id, message_id) values ($1,$2,$3)`, [
      U.alice,
      F.direct,
      F.aliceMessage,
    ]);
  });

  await scenario(db, "cleanup_push_log is not callable by clients", async (c) => {
    await as(c, U.alice);
    return denied(c, `select public.cleanup_push_log()`);
  });

  await scenario(db, "Cannot read another user's notifications", (c) =>
    as(c, U.alice).then(async () => {
      const r = await allowed(c, `select id from notifications where user_id=$1`, [U.carol]);
      return empty(r);
    }));

  /* ---------------- 6. secret-chat key material ------------------------- */

  await scenario(db, "Prekey bundle of a stranger is not readable", async (c) => {
    // Carol (who shares no chat with Alice) publishes her bundle through the
    // real RPC; Alice must not be able to read it.
    await as(c, U.carol);
    await allowed(
      c,
      `select public.publish_prekey_bundle(repeat('a',40), repeat('b',40), 1, repeat('c',40), repeat('d',40), '[]'::jsonb)`
    );
    await as(c, U.alice);
    const r = await allowed(c, `select identity_key from user_prekey_bundles where user_id=$1`, [U.carol]);
    return empty(r);
  });

  await scenario(db, "claim_prekey_bundle refuses users with no shared chat", (c) =>
    as(c, U.alice).then(() => denied(c, `select public.claim_prekey_bundle($1)`, [U.carol])));

  await scenario(db, "One-time prekeys are never readable by peers", async (c) => {
    await as(c, U.boris);
    await allowed(
      c,
      `select public.publish_prekey_bundle(repeat('a',40), repeat('b',40), 1, repeat('c',40), repeat('d',40),
              jsonb_build_array(jsonb_build_object('key_id', 7, 'public_key', repeat('e',40))))`
    );
    await as(c, U.alice); // Alice shares a direct chat with Boris
    const r = await allowed(c, `select public_key from user_one_time_prekeys`);
    return empty(r);
  });

  await scenario(db, "claim_prekey_bundle consumes an OPK exactly once", async (c) => {
    await as(c, U.boris);
    await allowed(
      c,
      `select public.publish_prekey_bundle(repeat('a',40), repeat('b',40), 1, repeat('c',40), repeat('d',40),
              jsonb_build_array(jsonb_build_object('key_id', 9, 'public_key', repeat('f',40))))`
    );
    await as(c, U.alice);
    const first = await allowed(c, `select public.claim_prekey_bundle($1) as b`, [U.boris]);
    const second = await allowed(c, `select public.claim_prekey_bundle($1) as b`, [U.boris]);
    return first.rows[0].b.one_time_key !== null && second.rows[0].b.one_time_key === null;
  });

  await scenario(db, "Publishing a prekey bundle cannot target another user", async (c) => {
    // The RPC has no user parameter at all: keys always land on auth.uid().
    await as(c, U.alice);
    await allowed(
      c,
      `select public.publish_prekey_bundle(repeat('a',40), repeat('b',40), 1, repeat('c',40), repeat('d',40), '[]'::jsonb)`
    );
    const r = await allowed(c, `select user_id from user_prekey_bundles`);
    return r.rowCount === 1 && r.rows[0].user_id === U.alice;
  });

  await scenario(db, "Identity-key change wipes the old one-time prekeys", async (c) => {
    await as(c, U.boris);
    await allowed(
      c,
      `select public.publish_prekey_bundle(repeat('a',40), repeat('b',40), 1, repeat('c',40), repeat('d',40),
              jsonb_build_array(jsonb_build_object('key_id', 1, 'public_key', repeat('1',40))))`
    );
    const before = await allowed(c, `select public.count_one_time_prekeys() as n`);
    // Rotate the identity key (what a reinstall does).
    await allowed(
      c,
      `select public.publish_prekey_bundle(repeat('z',40), repeat('y',40), 2, repeat('x',40), repeat('w',40),
              jsonb_build_array(jsonb_build_object('key_id', 2, 'public_key', repeat('2',40))))`
    );
    const after = await allowed(c, `select public.count_one_time_prekeys() as n`);
    return before.rows[0].n === 1 && after.rows[0].n === 1;
  });

  /* ---------------- 7. polls ------------------------------------------- */

  await scenario(db, "Non-member cannot vote in a poll", (c) =>
    as(c, U.carol).then(() =>
      denied(c, `select public.vote_luma_poll($1,$2)`, [F.poll, F.option])));

  await scenario(db, "Poll results of a foreign chat are not readable", (c) =>
    as(c, U.carol).then(async () => {
      const r = await allowed(c, `select poll_id from poll_vote_counts`);
      return empty(r);
    }));

  await scenario(db, "Member can vote and the aggregate table updates", async (c) => {
    await as(c, U.boris);
    await allowed(c, `select public.vote_luma_poll($1,$2)`, [F.poll, F.option]);
    const r = await allowed(c, `select votes from poll_vote_counts where poll_id=$1 and option_id=$2`, [
      F.poll,
      F.option,
    ]);
    return r.rows[0]?.votes === 1;
  });

  await scenario(db, "A voter cannot rewrite the aggregate table directly", async (c) => {
    await as(c, U.boris);
    return denied(c, `update poll_vote_counts set votes = 999 where poll_id=$1`, [F.poll]);
  });

  await scenario(db, "A non-member cannot read poll options", async (c) => {
    await as(c, U.carol);
    const r = await allowed(c, `select id from poll_options where poll_id=$1`, [F.poll]);
    return empty(r);
  });

  /* ---------------- 8. storage ----------------------------------------- */

  await scenario(db, "Chat media is readable by members only", (c) =>
    as(c, U.alice).then(async () => {
      const mine = await allowed(c, `select name from storage.objects where bucket_id='chat_media'`);
      return mine.rows.length === 1 && mine.rows[0].name.startsWith(F.direct);
    }));

  await scenario(db, "Uploads into another user's folder are rejected", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into storage.objects (bucket_id, name) values ('chat_media', $1)`, [
        `${F.direct}/${U.boris}/evil.png`,
      ])));

  await scenario(db, "Uploads into a chat you do not belong to are rejected", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into storage.objects (bucket_id, name) values ('chat_media', $1)`, [
        `${F.strangerDirect}/${U.alice}/evil.png`,
      ])));

  await scenario(db, "A group owner can upload their group's avatar", async (c) => {
    await as(c, U.alice);
    const r = await allowed(
      c,
      `insert into storage.objects (bucket_id, name, owner) values ('chat_media',$1,$2) returning id`,
      [`${F.group}/${U.alice}/avatar-1.png`, U.alice]
    );
    return r.rowCount === 1;
  });

  await scenario(db, "A plain member cannot change the group avatar", async (c) => {
    await as(c, U.boris);
    const mid = await allowed(c, `select public.update_group($1,'Hijacked',null)`, [F.group]).then(
      () => "allowed",
      () => "denied"
    );
    const row = await db().then(async (admin) => {
      const r = await admin.query(`select avatar_path, name from chats where id=$1`, [F.group]);
      await admin.end();
      return r.rows[0];
    });
    return mid === "denied" && row.name === "Team" && row.avatar_path === null;
  });

  await scenario(db, "A group admin can set the group avatar", async (c) => {
    await as(c, U.alice);
    await allowed(
      c,
      `insert into storage.objects (bucket_id, name, owner) values ('chat_media',$1,$2)`,
      [`${F.group}/${U.alice}/avatar-9.png`, U.alice]
    );
    await allowed(c, `select public.update_group($1,'Team', $2)`, [
      F.group,
      `${F.group}/${U.alice}/avatar-9.png`,
    ]);
    const r = await allowed(c, `select avatar_path from chats where id=$1`, [F.group]);
    return r.rows[0].avatar_path === `${F.group}/${U.alice}/avatar-9.png`;
  });

  await scenario(db, "An outsider cannot upload a channel avatar", async (c) => {
    await as(c, U.carol);
    return denied(c, `insert into storage.objects (bucket_id, name, owner) values ('chat_media',$1,$2)`, [
      `${F.publicChannel}/${U.carol}/avatar-3.png`,
      U.carol,
    ]);
  });

  await scenario(db, "Active file extensions are rejected at the storage layer", (c) =>
    as(c, U.alice).then(() =>
      denied(c, `insert into storage.objects (bucket_id, name) values ('chat_media', $1)`, [
        `${F.direct}/${U.alice}/payload.svg`,
      ])));

  await scenario(db, "Stranger avatars are not readable", (c) =>
    as(c, U.alice).then(async () => {
      const r = await allowed(c, `select name from storage.objects where bucket_id='avatars'`);
      return empty(r);
    }));

  await scenario(db, "Public-channel avatar is readable by any signed-in user", async (c) => {
    // Boris (channel owner) uploads the avatar; Dave, who is not a subscriber,
    // must still be able to load it because the channel is public.
    await as(c, U.boris);
    await allowed(c, `insert into storage.objects (bucket_id, name, owner) values ('chat_media',$1,$2)`, [
      `${F.publicChannel}/${U.boris}/avatar.png`,
      U.boris,
    ]);
    await as(c, U.dave);
    const r = await allowed(c, `select name from storage.objects where name=$1`, [
      `${F.publicChannel}/${U.boris}/avatar.png`,
    ]);
    return r.rowCount === 1;
  });

  await scenario(db, "Private-channel media is not readable by outsiders", async (c) => {
    await as(c, U.boris);
    await allowed(c, `insert into storage.objects (bucket_id, name, owner) values ('chat_media',$1,$2)`, [
      `${F.privateChannel}/${U.boris}/preview.png`,
      U.boris,
    ]);
    await as(c, U.alice);
    const r = await allowed(c, `select name from storage.objects where name=$1`, [
      `${F.privateChannel}/${U.boris}/preview.png`,
    ]);
    return empty(r);
  });

  await scenario(db, "Anonymous cannot touch storage", async (c) => {
    await asAnon(c);
    return denied(c, `select name from storage.objects`);
  });

  /* ---------------- 9. expired / deleted content ----------------------- */

  await scenario(db, "Expired message is invisible and then purged", async (c) => {
    // Written the way the TTL cron leaves a row: already past expires_at.
    const oc = await ownerAs(U.alice);
    const r = await oc.query(
      `insert into messages (chat_id, sender_id, body, expires_at)
       values ($1,$2,'burn after reading', now() - interval '1 second') returning id`,
      [F.direct, U.alice]
    );
    const id = r.rows[0].id;
    await as(c, U.alice);
    {
      const visible = await allowed(c, `select id from messages where id=$1`, [id]);
      if (!empty(visible)) return false;
      // End users must not be able to trigger the global sweep themselves …
      const sweepDenied = await denied(c, `select public.cleanup_expired_messages()`);
      if (!sweepDenied) return false;
      // … the pg_cron job runs it as service_role and must reclaim the row.
      await c.query("set local role service_role");
      const n = await allowed(c, `select public.cleanup_expired_messages() as n`);
      await c.query("set local role postgres"); // the sweep's own transaction
      const gone = await c.query(`select id from messages where id=$1`, [id]);
      if (!(n.rows[0].n >= 1 && gone.rowCount === 0)) {
        console.log("   sweep deleted", n.rows[0].n, "remaining", gone.rowCount);
        return false;
      }
      return true;
    }
  });

  await scenario(db, "'delete for me' hides the row from that user only", (c) =>
    as(c, U.alice).then(async () => {
      await allowed(c, `select public.delete_message_for_me($1)`, [F.borisMessage]);
      const hidden = await allowed(c, `select id from messages where id=$1`, [F.borisMessage]);
      if (!empty(hidden)) return false;
      await c.query("savepoint d1");
      await as(c, U.boris);
      const still = await allowed(c, `select id from messages where id=$1`, [F.borisMessage]);
      return still.rowCount === 1;
    }));

  /* ---------------- 10. SECURITY DEFINER hygiene ----------------------- */

  await scenario(db, "Every SECURITY DEFINER function pins search_path", async () => {
    const c = await db();
    try {
      const r = await c.query(`
        select p.proname, p.proconfig::text as cfg
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
          and (p.proconfig is null or not exists (
            select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'))
      `);
      if (r.rowCount) {
        console.log("   unpinned:", r.rows.map((x) => x.proname).join(", "));
        return false;
      }
      return true;
    } finally {
      await c.end();
    }
  });

  await scenario(db, "Rate-limit counters cannot be reset by a client", async (c) => {
    await as(c, U.alice);
    return denied(c, `select public.check_rate_limit('send_message', 60, 60)`);
  });

  await scenario(db, "No function is executable by anon", async () => {
    const c = await db();
    try {
      const r = await c.query(`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname !~ '^(citext|textic|regexp|split_part|strpos|translate|max|min|replace)'
          and has_function_privilege('anon', p.oid, 'EXECUTE')
      `);
      if (r.rowCount) {
        console.log("   anon-executable:", r.rows.map((x) => x.proname).join(", "));
        return false;
      }
      return true;
    } finally {
      await c.end();
    }
  });

  await scenario(db, "RLS is enabled on every public table", async () => {
    const c = await db();
    try {
      const r = await c.query(`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      `);
      if (r.rowCount) {
        console.log("   RLS off:", r.rows.map((x) => x.relname).join(", "));
        return false;
      }
      return true;
    } finally {
      await c.end();
    }
  });

  /* ------------------------------------------------------------- summary -- */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} authorization checks passed`);
  return failed.length === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await closeAllClients();
  if (!process.argv.includes("--keep")) {
    try {
      const url = new URL(DATABASE_URL);
      url.pathname = "/postgres";
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      await c.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`,
        [DB]
      );
      await c.query(`drop database if exists ${pg.escapeIdentifier(DB)}`);
      await c.end();
    } catch {
      /* best effort */
    }
  }
}
process.exit(code);
