import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  AtSign,
  Check,
  Loader2,
  Mic,
  Paperclip,
  Smile,
  Trash2,
  X,
} from "lucide-react";
import { bytes } from "../lib/format";
import type { MessageWithMeta, Profile } from "../lib/types";

const EMOJI = [
  "😀","😂","😍","🥰","😎","🤔","😅","🙌","🔥","✨","💜","❤️","👍","🙏","🎉","😭",
  "😴","🤯","🥳","😇","😤","🤝","👀","💯","🚀","🌙","☀️","🍕","☕","🎧","📎","💬",
];

export type SendPayload = { body: string; mentions: string[] };

export function Composer({
  chatId,
  meId,
  participants,
  onSend,
  onTyping,
  onVoice,
  replyTo,
  onCancelReply,
  disabled,
  placeholder,
  uploading,
  onFiles,
}: {
  chatId: string;
  meId: string;
  participants: Profile[];
  onSend: (payload: SendPayload) => void;
  onTyping: (typing: boolean) => void;
  onVoice: (blob: Blob, durationSec: number) => void;
  replyTo?: MessageWithMeta | null;
  onCancelReply: () => void;
  disabled?: boolean;
  placeholder?: string;
  uploading?: { name: string; size: number } | null;
  onFiles: (files: FileList | null) => void;
}) {
  const draftKey = `luma-draft:${chatId}`;
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recorded, setRecorded] = useState<{ blob: Blob; url: string; duration: number } | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<Profile[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingRef = useRef<number | null>(null);
  const lastTypingPing = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunks = useRef<Blob[]>([]);
  const recordStart = useRef(0);
  const recordTimer = useRef<number | null>(null);

  // Reset + reload draft when switching chats.
  useEffect(() => {
    try {
      setValue(localStorage.getItem(draftKey) ?? "");
    } catch {
      setValue("");
    }
    setRecorded(null);
    setRecording(false);
    setMentionOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 148)}px`;
  }, [value]);

  useEffect(() => {
    if (replyTo) taRef.current?.focus();
  }, [replyTo]);

  // Persist the draft (debounced by React render cycle — good enough locally).
  useEffect(() => {
    try {
      if (value) localStorage.setItem(draftKey, value);
      else localStorage.removeItem(draftKey);
    } catch {
      /* storage full / private mode — drafts are best-effort */
    }
  }, [value, draftKey]);

  function detectMentionQuery(v: string): string | null {
    const m = v.match(/(?:^|\s)@([a-z0-9_]{0,32})$/i);
    return m ? m[1].toLowerCase() : null;
  }

  function handleChange(v: string) {
    setValue(v);
    const now = Date.now();
    if (now - lastTypingPing.current > 2200) {
      lastTypingPing.current = now;
      onTyping(true);
    }
    if (typingRef.current) window.clearTimeout(typingRef.current);
    typingRef.current = window.setTimeout(() => onTyping(false), 3200);

    const q = detectMentionQuery(v);
    if (q !== null) {
      const list = participants
        .filter(
          (p) =>
            p.id !== meId &&
            ((p.username ?? "").toLowerCase().includes(q) ||
              p.display_name.toLowerCase().includes(q))
        )
        .slice(0, 6);
      setMentionCandidates(list);
      setMentionOpen(list.length > 0);
      setMentionIndex(0);
    } else {
      setMentionOpen(false);
    }
  }

  function insertMention(p: Profile) {
    const token = p.username ? `@${p.username}` : `@${p.display_name.replace(/\s+/g, "_")}`;
    setValue((v) => v.replace(/@([a-z0-9_]{0,32})$/i, `${token} `));
    setMentionOpen(false);
    taRef.current?.focus();
  }

  function resolveMentions(body: string): string[] {
    const found = new Set<string>();
    for (const p of participants) {
      if (!p.username) continue;
      const re = new RegExp(`(?:^|\\s)@${p.username}(?=$|\\s|[.,!?])`, "i");
      if (re.test(body)) found.add(p.id);
    }
    return [...found];
  }

  function submit() {
    const body = value.trim();
    if (!body) return;
    onSend({ body, mentions: resolveMentions(body) });
    setValue("");
    setEmojiOpen(false);
    setMentionOpen(false);
    onTyping(false);
    if (typingRef.current) window.clearTimeout(typingRef.current);
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------ voice notes ----------------------------- */

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find(
        (m) => MediaRecorder.isTypeSupported(m)
      );
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recordChunks.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) recordChunks.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(recordChunks.current, { type });
        const url = URL.createObjectURL(blob);
        const duration = (Date.now() - recordStart.current) / 1000;
        setRecorded({ blob, url, duration });
        setRecording(false);
        setRecordSeconds(0);
        if (recordTimer.current) window.clearInterval(recordTimer.current);
      };
      recorderRef.current = recorder;
      recordStart.current = Date.now();
      recorder.start(250);
      setRecording(true);
      setRecordSeconds(0);
      recordTimer.current = window.setInterval(
        () => setRecordSeconds(Math.floor((Date.now() - recordStart.current) / 1000)),
        250
      );
    } catch {
      alert("Microphone access denied or unavailable.");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
  }

  function discardRecording() {
    if (recorded) URL.revokeObjectURL(recorded.url);
    setRecorded(null);
  }

  function sendVoice() {
    if (!recorded) return;
    onVoice(recorded.blob, Math.max(0.5, recorded.duration));
    URL.revokeObjectURL(recorded.url);
    setRecorded(null);
  }

  const charCount = value.length;

  return (
    <div className="relative border-t border-white/[0.07] bg-luma-ink/55 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-2xl sm:px-5">
      {/* reply banner */}
      <AnimatePresence>
        {replyTo && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-2 overflow-hidden"
          >
            <div className="flex items-center gap-2 rounded-xl border-l-2 border-luma-400 bg-white/[0.05] px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium text-luma-300">
                  Replying to {replyTo.sender?.display_name ?? "message"}
                </div>
                <div className="truncate text-[12px] text-slate-400">
                  {replyTo.body || "Attachment"}
                </div>
              </div>
              <button onClick={onCancelReply} className="btn-icon h-8 w-8" aria-label="Cancel reply">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* uploading indicator */}
      <AnimatePresence>
        {uploading && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-2 overflow-hidden"
          >
            <div className="flex items-center gap-2 rounded-xl border border-luma-400/25 bg-luma-500/10 px-3 py-2 text-[12px] text-luma-200">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Uploading {uploading.name} · {bytes(uploading.size)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* voice note review */}
      <AnimatePresence>
        {recorded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-2 overflow-hidden"
          >
            <div className="flex items-center gap-2 rounded-2xl border border-luma-400/30 bg-luma-500/10 px-3 py-2">
              <audio src={recorded.url} controls className="h-9 min-w-0 flex-1" />
              <button onClick={sendVoice} className="grid h-9 w-9 place-items-center rounded-full bg-luma-gradient text-white" aria-label="Send voice message">
                <Check className="h-4 w-4" />
              </button>
              <button onClick={discardRecording} className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-rose-200 hover:bg-white/15" aria-label="Discard">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* mention suggestions */}
      <AnimatePresence>
        {mentionOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="absolute bottom-[calc(100%+4px)] left-3 z-30 w-64 overflow-hidden rounded-2xl border border-white/10 bg-luma-panel/95 py-1.5 shadow-2xl backdrop-blur-2xl sm:left-5"
          >
            {mentionCandidates.map((p, i) => (
              <button
                key={p.id}
                onMouseEnter={() => setMentionIndex(i)}
                onClick={() => insertMention(p)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] ${
                  i === mentionIndex ? "bg-luma-500/20 text-white" : "text-slate-300"
                }`}
              >
                <AtSign className="h-3.5 w-3.5 text-luma-300" />
                <span className="truncate">{p.username ?? p.display_name}</span>
                <span className="ml-auto truncate text-[11px] text-slate-500">{p.display_name}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* emoji sheet */}
      <AnimatePresence>
        {emojiOpen && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            className="glass-strong absolute bottom-[calc(100%-4px)] left-3 right-3 z-20 mb-1 grid max-w-sm grid-cols-8 gap-1 rounded-2xl p-2.5 sm:left-5"
          >
            {EMOJI.map((e) => (
              <button
                key={e}
                onClick={() => {
                  setValue((v) => v + e);
                  taRef.current?.focus();
                }}
                className="grid h-8 place-items-center rounded-lg text-[17px] transition-transform hover:scale-125 hover:bg-white/10"
              >
                {e}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* recording bar */}
      {recording ? (
        <div className="flex items-center gap-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3">
          <span className="relative flex h-3.5 w-3.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-60" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-rose-500" />
          </span>
          <span className="font-mono text-[14px] tabular-nums text-rose-100">
            {Math.floor(recordSeconds / 60)}:{String(recordSeconds % 60).padStart(2, "0")}
          </span>
          <span className="text-[12px] text-rose-200/80">Recording…</span>
          <button onClick={stopRecording} className="ml-auto btn-primary h-9 px-4 text-[13px]">
            Stop
          </button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              onFiles(e.target.files);
              e.currentTarget.value = "";
            }}
          />

          <button
            onClick={() => fileRef.current?.click()}
            className="btn-icon mb-0.5"
            aria-label="Attach a file"
            disabled={disabled}
          >
            <Paperclip className="h-[18px] w-[18px]" />
          </button>

          <div className="relative flex min-w-0 flex-1 items-end rounded-[22px] border border-white/10 bg-white/[0.06] px-1.5 py-1 transition-all focus-within:border-luma-400/60 focus-within:bg-white/[0.09] focus-within:ring-4 focus-within:ring-luma-500/12">
            <button
              onClick={() => setEmojiOpen((v) => !v)}
              className="mb-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-luma-200"
              aria-label="Emoji"
            >
              <Smile className="h-[18px] w-[18px]" />
            </button>
            <textarea
              ref={taRef}
              rows={1}
              value={value}
              disabled={disabled}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && mentionOpen) {
                  e.preventDefault();
                  const pick = mentionCandidates[mentionIndex];
                  if (pick) insertMention(pick);
                  return;
                }
                if (e.key === "Tab" && mentionOpen) {
                  e.preventDefault();
                  const pick = mentionCandidates[mentionIndex];
                  if (pick) insertMention(pick);
                  return;
                }
                if (e.key === "ArrowDown" && mentionOpen) {
                  e.preventDefault();
                  setMentionIndex((i) => Math.min(mentionCandidates.length - 1, i + 1));
                  return;
                }
                if (e.key === "ArrowUp" && mentionOpen) {
                  e.preventDefault();
                  setMentionIndex((i) => Math.max(0, i - 1));
                  return;
                }
                if (e.key === "Escape" && mentionOpen) {
                  setMentionOpen(false);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={placeholder ?? "Message…"}
              maxLength={8000}
              className="max-h-[148px] min-h-[38px] flex-1 resize-none bg-transparent px-1 py-2 text-[14.5px] leading-[1.45] text-slate-100 placeholder-slate-500 focus:outline-none"
            />
            {charCount > 1500 && (
              <span className={`pointer-events-none absolute -top-2 right-3 rounded-full px-2 py-0.5 text-[10px] font-medium ${charCount > 7500 ? "bg-rose-500/20 text-rose-200" : "bg-white/10 text-slate-400"}`}>
                {charCount}/8000
              </span>
            )}
          </div>

          {value.trim() ? (
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={submit}
              disabled={disabled}
              className="mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-luma-gradient text-white shadow-bubble transition-all disabled:opacity-40"
              aria-label="Send message"
            >
              <ArrowUp className="h-5 w-5" strokeWidth={2.6} />
            </motion.button>
          ) : (
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={startRecording}
              disabled={disabled}
              className="mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-white/10 bg-white/[0.06] text-luma-200 transition-all hover:bg-white/[0.1] disabled:opacity-40"
              aria-label="Record voice message"
            >
              <Mic className="h-5 w-5" />
            </motion.button>
          )}
        </div>
      )}
    </div>
  );
}
