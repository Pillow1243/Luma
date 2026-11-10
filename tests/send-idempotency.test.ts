import test from "node:test";
import assert from "node:assert/strict";
const { supabase } = await import("../src/lib/supabase.ts");
const { sendMessage } = await import("../src/lib/data.ts");

test("an ambiguous send retries with the same UUID and reconciles the existing row", async () => {
  const row = { id: "client-generated-id", chat_id: "chat", sender_id: "alice", body: "hello" };
  let inserted: any;
  const filters: Record<string, string> = {};
  (supabase as any).from = () => ({
    insert: (data: any) => { inserted = data; return { select: () => ({ single: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }) }) }; },
    select: () => {
      const builder: any = { eq: (column: string, value: string) => { filters[column] = value; return builder; }, maybeSingle: async () => ({ data: row, error: null }) };
      return builder;
    },
  });
  const result = await sendMessage({ id: row.id, chatId: "chat", senderId: "alice", body: "hello" });
  assert.equal(inserted.id, row.id);
  assert.deepEqual(filters, { id: row.id, chat_id: "chat", sender_id: "alice" });
  assert.deepEqual(result, row);
});

test("a conflicting UUID cannot reconcile another sender's message", async () => {
  (supabase as any).from = () => ({
    insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }) }) }),
    select: () => { const builder: any = { eq: () => builder, maybeSingle: async () => ({ data: null, error: null }) }; return builder; },
  });
  await assert.rejects(() => sendMessage({ id: "other", chatId: "chat", senderId: "alice", body: "hello" }));
});
