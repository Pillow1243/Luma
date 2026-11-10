import { useCallback, useEffect, useState } from "react";
import { BarChart3, Loader2, Plus, Trash2 } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useToast } from "../context/ToastContext";
import { useOffline } from "../context/OfflineContext";
import { Modal } from "./Modal";

type Poll = { id: string; question: string };
type Option = { id: string; label: string; position: number };
type Vote = { option_id: string; user_id: string };

export function PollBlock({ messageId, fallback, meId }: { messageId: string; fallback: string; meId: string }) {
  const [poll, setPoll] = useState<Poll | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const { connection } = useOffline();
  const toast = useToast();
  const refreshVotes = useCallback(async (pollId: string) => {
    const { data } = await supabase.from("poll_votes").select("option_id,user_id").eq("poll_id", pollId);
    setVotes((data ?? []) as Vote[]);
  }, []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const { data } = await supabase.from("polls").select("id,question").eq("message_id", messageId).maybeSingle();
      if (!alive || !data) { if (alive) setLoading(false); return; }
      const p = data as Poll;
      const [{ data: opts }, { data: selected }] = await Promise.all([
        supabase.from("poll_options").select("id,label,position").eq("poll_id", p.id).order("position"),
        supabase.from("poll_votes").select("option_id,user_id").eq("poll_id", p.id),
      ]);
      if (alive) { setPoll(p); setOptions((opts ?? []) as Option[]); setVotes((selected ?? []) as Vote[]); setLoading(false); }
    })().catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [messageId, connection]);
  useEffect(() => {
    if (!poll) return;
    const channel = supabase.channel(`luma:poll:${poll.id}:${crypto.randomUUID()}`).on("postgres_changes", { event: "*", schema: "public", table: "poll_votes", filter: `poll_id=eq.${poll.id}` }, () => { void refreshVotes(poll.id); }).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [poll, refreshVotes]);
  async function vote(option: string) {
    if (!poll || voting || connection !== "online") return;
    setVoting(true);
    try {
      const { error } = await supabase.rpc("vote_luma_poll", { poll_uuid: poll.id, option_uuid: option });
      if (error) throw error;
      await refreshVotes(poll.id);
    } catch (error) { toast.push((error as Error).message || "Could not vote", "error"); }
    finally { setVoting(false); }
  }
  if (loading) return <span className="opacity-70">{fallback}</span>;
  if (!poll) return <span>{fallback}</span>;
  const mine = votes.find((v) => v.user_id === meId)?.option_id;
  return <div className="min-w-[min(15rem,65vw)] max-w-sm">
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider opacity-70"><BarChart3 className="h-3.5 w-3.5" /> Poll · votes visible to members</div>
    <p className="mt-2 font-semibold">{poll.question}</p>
    <div className="mt-3 space-y-2">{options.map((option) => {
      const count = votes.filter((v) => v.option_id === option.id).length;
      const percent = votes.length ? Math.round(count * 100 / votes.length) : 0;
      return <button key={option.id} disabled={voting || connection !== "online"} onClick={() => void vote(option.id)} className={`relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-xl border px-3 py-2 text-left text-[12px] disabled:opacity-70 ${mine === option.id ? "border-emerald-300/60" : "border-white/20"}`}>
        <span className="absolute inset-y-0 left-0 bg-white/15 transition-all" style={{ width: `${percent}%` }} />
        <span className="relative">{option.label}{mine === option.id ? " ✓" : ""}</span><span className="relative shrink-0 opacity-80">{percent}%</span>
      </button>;
    })}</div><p className="mt-2 text-[10.5px] opacity-65">{votes.length} vote{votes.length === 1 ? "" : "s"} · tap to {mine ? "change vote" : "vote"}</p>
  </div>;
}

export function CreatePollModal({ open, onClose, chatId, onCreated }: { open: boolean; onClose: () => void; chatId: string; onCreated: () => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  async function submit() {
    const cleaned = options.map((v) => v.trim()).filter(Boolean);
    if (!question.trim() || cleaned.length < 2) { toast.push("Add a question and at least two options", "error"); return; }
    setSaving(true);
    try {
      const { error } = await supabase.rpc("create_luma_poll", { cid: chatId, poll_question: question.trim(), poll_options: cleaned });
      if (error) throw error;
      setQuestion(""); setOptions(["", ""]); onClose(); onCreated();
    } catch (error) { toast.push((error as Error).message || "Could not create poll", "error"); }
    finally { setSaving(false); }
  }
  return <Modal open={open} onClose={onClose} title="Create a poll" subtitle="One vote per person. Votes are visible to chat members.">
    <label className="block text-xs font-medium text-slate-300">Question<input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={240} className="field mt-2" placeholder="What would you like to ask?" /></label>
    <div className="mt-4 space-y-2">{options.map((option, i) => <div key={i} className="flex gap-2"><input value={option} onChange={(e) => setOptions((prev) => prev.map((v, j) => j === i ? e.target.value : v))} maxLength={100} className="field" placeholder={`Option ${i + 1}`} />{options.length > 2 && <button onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove option ${i + 1}`} className="btn-icon shrink-0"><Trash2 className="h-4 w-4" /></button>}</div>)}</div>
    {options.length < 10 && <button onClick={() => setOptions((prev) => [...prev, ""])} className="btn-ghost mt-3 px-3 py-2 text-xs"><Plus className="h-4 w-4" /> Add option</button>}
    <button onClick={() => void submit()} disabled={saving} className="btn-primary mt-5 w-full">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />} Create poll</button>
  </Modal>;
}
