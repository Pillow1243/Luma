import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Clock, Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useToast } from "../context/ToastContext";
import { useOffline } from "../context/OfflineContext";
import { Modal } from "./Modal";

type Poll = {
  id: string;
  question: string;
  allow_multiple: boolean;
  anonymous: boolean;
  closes_at: string | null;
};
type Option = { id: string; label: string; position: number };
type Vote = { option_id: string; user_id: string };
type Result = { option_id: string; votes: number };

function useCountdown(closesAt: string | null): { label: string | null; closed: boolean } {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!closesAt) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [closesAt]);
  if (!closesAt) return { label: null, closed: false };
  const remaining = new Date(closesAt).getTime() - Date.now();
  if (remaining <= 0) return { label: "Poll closed", closed: true };
  const mins = Math.floor(remaining / 60000);
  if (mins < 60) return { label: `Closes in ${mins}m`, closed: false };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { label: `Closes in ${hours}h`, closed: false };
  return { label: `Closes in ${Math.floor(hours / 24)}d`, closed: false };
}

export function PollBlock({ messageId, fallback, meId }: { messageId: string; fallback: string; meId: string }) {
  const [poll, setPoll] = useState<Poll | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [myVotes, setMyVotes] = useState<Vote[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState<string | null>(null);
  const { connection } = useOffline();
  const toast = useToast();
  const { label: countdownLabel, closed } = useCountdown(poll?.closes_at ?? null);

  const refreshVotes = useCallback(async (pollId: string) => {
    const [{ data: mine }, { data: agg }] = await Promise.all([
      supabase.from("poll_votes").select("option_id,user_id").eq("poll_id", pollId).eq("user_id", meId),
      supabase.rpc("get_poll_results", { poll_uuid: pollId }),
    ]);
    setMyVotes((mine ?? []) as Vote[]);
    setResults((agg ?? []) as Result[]);
  }, [meId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const { data } = await supabase
        .from("polls")
        .select("id,question,allow_multiple,anonymous,closes_at")
        .eq("message_id", messageId)
        .maybeSingle();
      if (!alive || !data) { if (alive) setLoading(false); return; }
      const p = data as Poll;
      const [{ data: opts }] = await Promise.all([
        supabase.from("poll_options").select("id,label,position").eq("poll_id", p.id).order("position"),
      ]);
      if (!alive) return;
      setPoll(p);
      setOptions((opts ?? []) as Option[]);
      await refreshVotes(p.id);
      if (alive) setLoading(false);
    })().catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [messageId, connection, refreshVotes]);

  useEffect(() => {
    if (!poll) return;
    const channel = supabase
      .channel(`luma:poll:${poll.id}:${crypto.randomUUID()}`)
      .on(
        // Subscribe to the identity-free aggregate table, not poll_votes
        // directly: Realtime enforces each subscriber's own RLS before
        // delivering postgres_changes events, and poll_votes_read only
        // exposes a member's own vote row on anonymous polls. That meant
        // other members never received a change event when someone else
        // voted anonymously, so their results went stale. poll_vote_counts
        // is readable by every chat member regardless of anonymity (it
        // never carries voter identity), so everyone reliably gets notified
        // to refresh. See supabase/migrations/20261110123641_luma_poll_realtime_fix.sql.
        "postgres_changes",
        { event: "*", schema: "public", table: "poll_vote_counts", filter: `poll_id=eq.${poll.id}` },
        () => { void refreshVotes(poll.id); }
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [poll, refreshVotes]);

  async function vote(option: string) {
    if (!poll || voting || connection !== "online" || closed) return;
    setVoting(option);
    try {
      const { error } = await supabase.rpc("vote_luma_poll", { poll_uuid: poll.id, option_uuid: option });
      if (error) throw error;
      await refreshVotes(poll.id);
    } catch (error) {
      toast.push((error as Error).message || "Could not vote", "error");
    } finally {
      setVoting(null);
    }
  }

  const totalVotes = useMemo(() => results.reduce((sum, r) => sum + r.votes, 0), [results]);

  if (loading) return <span className="opacity-70">{fallback}</span>;
  if (!poll) return <span>{fallback}</span>;
  const mineIds = new Set(myVotes.map((v) => v.option_id));

  return (
    <div className="min-w-[min(15rem,65vw)] max-w-sm">
      <div className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wider opacity-70">
        <span className="flex items-center gap-2">
          <BarChart3 className="h-3.5 w-3.5" />
          {poll.anonymous ? (
            <span className="flex items-center gap-1"><EyeOff className="h-3 w-3" /> Anonymous poll</span>
          ) : (
            <span className="flex items-center gap-1"><Eye className="h-3 w-3" /> Votes visible to members</span>
          )}
        </span>
        {countdownLabel && (
          <span className="flex items-center gap-1 normal-case tracking-normal opacity-80">
            <Clock className="h-3 w-3" /> {countdownLabel}
          </span>
        )}
      </div>
      <p className="mt-2 font-semibold">{poll.question}</p>
      {poll.allow_multiple && (
        <p className="mt-0.5 text-[10.5px] opacity-60">Select one or more options</p>
      )}
      <div className="mt-3 space-y-2">
        {options.map((option) => {
          const count = results.find((r) => r.option_id === option.id)?.votes ?? 0;
          const percent = totalVotes ? Math.round((count * 100) / totalVotes) : 0;
          const mine = mineIds.has(option.id);
          return (
            <button
              key={option.id}
              disabled={voting !== null || connection !== "online" || closed}
              onClick={() => void vote(option.id)}
              className={`relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-xl border px-3 py-2 text-left text-[12px] disabled:opacity-70 ${
                mine ? "border-emerald-300/60" : "border-white/20"
              }`}
            >
              <span className="absolute inset-y-0 left-0 bg-white/15 transition-all" style={{ width: `${percent}%` }} />
              <span className="relative">
                {option.label}
                {mine ? " ✓" : ""}
              </span>
              <span className="relative shrink-0 opacity-80">{percent}%</span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[10.5px] opacity-65">
        {totalVotes} vote{totalVotes === 1 ? "" : "s"}
        {closed ? " · voting closed" : ` · tap to ${poll.allow_multiple ? "toggle" : mineIds.size ? "change vote" : "vote"}`}
      </p>
    </div>
  );
}

export function CreatePollModal({
  open,
  onClose,
  chatId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  onCreated: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [closesIn, setClosesIn] = useState<"" | "3600" | "86400" | "604800">("");
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  async function submit() {
    const cleaned = options.map((v) => v.trim()).filter(Boolean);
    if (!question.trim() || cleaned.length < 2) {
      toast.push("Add a question and at least two options", "error");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc("create_luma_poll", {
        cid: chatId,
        poll_question: question.trim(),
        poll_options: cleaned,
        p_allow_multiple: allowMultiple,
        p_anonymous: anonymous,
        p_closes_in_seconds: closesIn ? Number(closesIn) : null,
      });
      if (error) throw error;
      setQuestion("");
      setOptions(["", ""]);
      setAllowMultiple(false);
      setAnonymous(false);
      setClosesIn("");
      onClose();
      onCreated();
    } catch (error) {
      toast.push((error as Error).message || "Could not create poll", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Create a poll" subtitle="Ask the chat a question with up to 10 options.">
      <label className="block text-xs font-medium text-slate-300">
        Question
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={240}
          className="field mt-2"
          placeholder="What would you like to ask?"
        />
      </label>
      <div className="mt-4 space-y-2">
        {options.map((option, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={option}
              onChange={(e) => setOptions((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
              maxLength={100}
              className="field"
              placeholder={`Option ${i + 1}`}
            />
            {options.length > 2 && (
              <button
                onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove option ${i + 1}`}
                className="btn-icon shrink-0"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>
      {options.length < 10 && (
        <button onClick={() => setOptions((prev) => [...prev, ""])} className="btn-ghost mt-3 px-3 py-2 text-xs">
          <Plus className="h-4 w-4" /> Add option
        </button>
      )}

      <div className="mt-5 space-y-3 border-t border-white/10 pt-4">
        <label className="flex items-center justify-between text-xs font-medium text-slate-300">
          <span>Allow multiple answers</span>
          <input
            type="checkbox"
            checked={allowMultiple}
            onChange={(e) => setAllowMultiple(e.target.checked)}
            className="h-4 w-4 accent-violet-500"
          />
        </label>
        <label className="flex items-center justify-between text-xs font-medium text-slate-300">
          <span>Anonymous voting (hide who voted for what)</span>
          <input
            type="checkbox"
            checked={anonymous}
            onChange={(e) => setAnonymous(e.target.checked)}
            className="h-4 w-4 accent-violet-500"
          />
        </label>
        <label className="block text-xs font-medium text-slate-300">
          Closing deadline
          <select
            value={closesIn}
            onChange={(e) => setClosesIn(e.target.value as typeof closesIn)}
            className="field mt-2"
          >
            <option value="">No deadline</option>
            <option value="3600">1 hour</option>
            <option value="86400">1 day</option>
            <option value="604800">1 week</option>
          </select>
        </label>
      </div>

      <button onClick={() => void submit()} disabled={saving} className="btn-primary mt-5 w-full">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />} Create poll
      </button>
    </Modal>
  );
}
