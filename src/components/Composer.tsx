import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  BarChart3,
  Sticker,
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
import { useToast } from "../context/ToastContext";
import { useI18n } from "../lib/i18n";
import { StickerPicker } from "./StickerPicker";
import type { MessageWithMeta, Profile } from "../lib/types";

const EMOJI = [
  "😀","😂","😍","🥰","😎","🤔","😅","🙌","🔥","✨","💜","❤️","👍","🙏","🎉","😭",
  "😴","🤯","🥳","😇","😤","🤝","👀","💯","🚀","🌙","☀️","🍕","☕","🎧","📎","💬",
];

export type SendPayload = { body: string; mentions: string[] };

function downsampleWaveform(samples: number[], bars = 32): number[] {
  if (!samples.length) return Array.from({ length: bars }, () => 0.3);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i * samples.length) / bars);
    const end = Math.max(start + 1, Math.floor(((i + 1) * samples.length) / bars));
    let peak = 0;
    for (let j = start; j < end; j++) peak = Math.max(peak, samples[j]);
    out.push(Number(Math.min(1, Math.max(0.15, peak)).toFixed(2)));
  }
  return out;
}

export function Composer({
  chatId,
  meId,
  participants,
  onSend,
  onTyping,
  onVoice,
  replyTo,
  onCancelReply,
  onEditLast,
  disabled,
  placeholder,
  uploading,
  onFiles,
  canUpload = true,
  secret = false,
  onCreatePoll,
}: {
  chatId: string;
  meId: string;
  participants: Profile[];
  onSend: (payload: SendPayload) => Promise<boolean>;
  onTyping: (typing: boolean) => void;
  onVoice: (blob: Blob, durationSec: number, waveform: number[]) => void;
  replyTo?: MessageWithMeta | null;
  onCancelReply: () => void;
  onEditLast?: () => void;
  disabled?: boolean;
  placeholder?: string;
  uploading?: { name: string; size: number } | null;
  onFiles: (files: FileList | null) => void;
  canUpload?: boolean;
  secret?: boolean;
  onCreatePoll?: () => void;
}) {
  const toast = useToast();
  const { t } = useI18n();
  const draftKey = `luma-draft:${chatId}`;
  const [value, setValue] = useState(() => {
    try {
      return secret ? "" : localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [liveBars, setLiveBars] = useState<number[]>(() => Array(24).fill(0.2));
  const [recorded, setRecorded] = useState<{
    blob: Blob;
    url: string;
    duration: number;
    waveform: number[];
  } | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<Profile[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingRef = useRef<number | null>(null);
  const lastTypingPing = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunks = useRef<Blob[]>([]);
  const recordSamples = useRef<number[]>([]);
  const recordStart = useRef(0);
  const recordTimer = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    try {
      setValue(secret ? "" : localStorage.getItem(draftKey) ?? "");
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

  const secretRef = useRef({ chatId, secret });

  useEffect(() => {
    if (secretRef.current.chatId === chatId && secretRef.current.secret && !secret) return;
    try {
      if (secret) localStorage.removeItem(draftKey);
      else if (value) localStorage.setItem(draftKey, value);
      else localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }, [value, draftKey, secret, chatId]);

  useEffect(() => {
    if (secretRef.current.chatId === chatId && secretRef.current.secret && !secret) {
      setValue("");
      setMentionOpen(false);
    }
    secretRef.current = { chatId, secret };
  }, [chatId, secret]);

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
    if (!secret && q !== null) {
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

  async function submit() {
    const body = value.trim();
    if (!body || submitting || disabled) return;
    setSubmitting(true);
    try {
      const accepted = await onSend({ body, mentions: resolveMentions(body) });
      if (!accepted) return;
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
    } finally {
      setSubmitting(false);
    }
  }

  async function sendSticker(body: string) {
    if (submitting || disabled || secret) return;
    setSubmitting(true);
    try {
      if (await onSend({ body, mentions: [] })) setStickersOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  /* ------------------------------ voice notes ----------------------------- */

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((m) => MediaRecorder.isTypeSupported(m));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recordChunks.current = [];
      recordSamples.current = [];
      setLiveBars(Array(24).fill(0.2));

      let analyser: AnalyserNode | null = null;
      let dataArray: Uint8Array | null = null;
      try {
        const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioCtor) {
          const ctx = new AudioCtor();
          audioCtxRef.current = ctx;
          const src = ctx.createMediaStreamSource(stream);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 64;
          src.connect(analyser);
          dataArray = new Uint8Array(analyser.frequencyBinCount);
        }
      } catch {
        // Waveform sampling falls back gracefully
      }

      recorder.ondataavailable = (e) => {
        if (e.data.size) recordChunks.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void audioCtxRef.current?.close().catch(() => {});
        audioCtxRef.current = null;
        if (recordTimer.current) window.clearInterval(recordTimer.current);
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(recordChunks.current, { type });
        const url = URL.createObjectURL(blob);
        const duration = (Date.now() - recordStart.current) / 1000;
        const waveform = downsampleWaveform(recordSamples.current, 32);
        setRecorded({ blob, url, duration, waveform });
        setRecording(false);
        setRecordSeconds(0);
      };

      recorderRef.current = recorder;
      recordStart.current = Date.now();
      recorder.start(250);
      setRecording(true);
      setRecordSeconds(0);

      recordTimer.current = window.setInterval(() => {
        setRecordSeconds(Math.floor((Date.now() - recordStart.current) / 1000));
        if (analyser && dataArray) {
          analyser.getByteTimeDomainData(dataArray as Uint8Array<ArrayBuffer>);
          let peak = 0;
          for (let i = 0; i < dataArray.length; i++) {
            peak = Math.max(peak, Math.abs(dataArray[i] - 128) / 128);
          }
          const level = Math.min(1, Math.max(0.15, peak * 2.2));
          recordSamples.current.push(level);
          setLiveBars((prev) => [...prev.slice(1), level]);
        } else {
          const level = 0.25 + Math.random() * 0.45;
          recordSamples.current.push(level);
          setLiveBars((prev) => [...prev.slice(1), level]);
        }
      }, 120);
    } catch {
      toast.push("Microphone access denied or unavailable.", "error");
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
    onVoice(recorded.blob, Math.max(0.5, recorded.duration), recorded.waveform);
    URL.revokeObjectURL(recorded.url);
    setRecorded(null);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled || !canUpload) return;
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      onFiles(files);
    }
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
            <div className="flex items-center gap-2 rounded-xl border-s-2 border-luma-400 bg-white/[0.05] px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium text-luma-300">
                  Replying to {replyTo.sender?.display_name ?? "message"}
                </div>
                <div className="truncate text-[12px] text-slate-400">
                  {replyTo.body?.startsWith("luma:e2ee:")
                    ? "🔒 Encrypted message"
                    : replyTo.body || "Attachment"}
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
              {secret ? "Encrypting & uploading" : "Uploading"} {uploading.name} · {bytes(uploading.size)}
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
              <button
                onClick={sendVoice}
                className="grid h-9 w-9 place-items-center rounded-full bg-luma-gradient text-white"
                aria-label="Send voice message"
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                onClick={discardRecording}
                className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-rose-200 hover:bg-white/15"
                aria-label="Discard"
              >
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
            className="absolute bottom-[calc(100%+4px)] start-3 z-30 w-64 overflow-hidden rounded-2xl border border-white/10 bg-luma-panel/95 py-1.5 shadow-2xl backdrop-blur-2xl sm:start-5"
          >
            {mentionCandidates.map((p, i) => (
              <button
                key={p.id}
                onMouseEnter={() => setMentionIndex(i)}
                onClick={() => insertMention(p)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-start text-[13px] ${
                  i === mentionIndex ? "bg-luma-500/20 text-white" : "text-slate-300"
                }`}
              >
                <AtSign className="h-3.5 w-3.5 text-luma-300" />
                <span className="truncate">{p.username ?? p.display_name}</span>
                <span className="ms-auto truncate text-[11px] text-slate-500">{p.display_name}</span>
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
            className="glass-strong absolute bottom-[calc(100%-4px)] start-3 end-3 z-20 mb-1 grid max-w-sm grid-cols-8 gap-1 rounded-2xl p-2.5 sm:start-5"
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

      {stickersOpen && !secret && (
        <StickerPicker
          onClose={() => setStickersOpen(false)}
          onSelect={(body) => void sendSticker(body)}
        />
      )}

      {/* recording bar with live waveform */}
      {recording ? (
        <div className="flex items-center gap-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-2.5">
          <span className="relative flex h-3.5 w-3.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-60" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-rose-500" />
          </span>
          <span className="font-mono text-[14px] tabular-nums text-rose-100">
            {Math.floor(recordSeconds / 60)}:{String(recordSeconds % 60).padStart(2, "0")}
          </span>
          <div className="flex h-6 flex-1 items-center gap-0.5 overflow-hidden" aria-hidden="true">
            {liveBars.map((bar, i) => (
              <span
                key={i}
                className="flex-1 rounded-full bg-rose-300/80 transition-all duration-100"
                style={{ height: `${Math.round(bar * 100)}%` }}
              />
            ))}
          </div>
          <span className="hidden text-[12px] text-rose-200/80 sm:inline">{t("recordingVoice")}</span>
          <button onClick={stopRecording} className="ms-auto btn-primary h-9 px-4 text-[13px]">
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
            aria-label={t("attachFile")}
            title={
              !canUpload
                ? "Attachments require a connection"
                : secret
                  ? "Attach encrypted file"
                  : t("attachFile")
            }
            disabled={disabled || !canUpload}
          >
            <Paperclip className="h-[18px] w-[18px]" />
          </button>

          <button
            onClick={() => {
              setStickersOpen((v) => !v);
              setEmojiOpen(false);
            }}
            disabled={disabled || secret}
            className="btn-icon mb-0.5 hidden h-10 w-10 shrink-0 sm:grid disabled:opacity-30"
            aria-label="Stickers and GIFs"
          >
            <Sticker className="h-[18px] w-[18px]" />
          </button>

          <div className="relative flex min-w-0 flex-1 items-end rounded-[22px] border border-white/10 bg-white/[0.06] px-1.5 py-1 transition-all focus-within:border-luma-400/60 focus-within:bg-white/[0.09] focus-within:ring-4 focus-within:ring-luma-500/12">
            <button
              onClick={() => setEmojiOpen((v) => !v)}
              className="mb-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-luma-200"
              aria-label="Emoji"
            >
              <Smile className="h-[18px] w-[18px]" />
            </button>
            <button
              onClick={() => {
                setStickersOpen((v) => !v);
                setEmojiOpen(false);
              }}
              disabled={disabled || secret}
              className="mb-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 sm:hidden disabled:opacity-30"
              aria-label="Stickers and GIFs"
            >
              <Sticker className="h-4 w-4" />
            </button>
            <button
              onClick={onCreatePoll}
              disabled={disabled || secret || !canUpload}
              className="mb-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 disabled:opacity-30"
              aria-label="Create poll"
              title="Create poll"
            >
              <BarChart3 className="h-4 w-4" />
            </button>
            <textarea
              ref={taRef}
              rows={1}
              value={value}
              disabled={disabled || submitting}
              onChange={(e) => handleChange(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp" && !value && onEditLast && !secret) {
                  e.preventDefault();
                  onEditLast();
                  return;
                }
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
              placeholder={placeholder ?? (secret ? t("secretMessagePlaceholder") : t("typeMessage"))}
              maxLength={secret ? 4000 : 5000}
              className="max-h-[148px] min-h-[38px] flex-1 resize-none bg-transparent px-1 py-2 text-[14.5px] leading-[1.45] text-slate-100 placeholder-slate-500 focus:outline-none"
            />
            {charCount > (secret ? 3200 : 1500) && (
              <span
                className={`pointer-events-none absolute -top-2 end-3 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  charCount > (secret ? 3800 : 4800)
                    ? "bg-rose-500/20 text-rose-200"
                    : "bg-white/10 text-slate-400"
                }`}
              >
                {charCount}/{secret ? 4000 : 5000}
              </span>
            )}
          </div>

          {value.trim() ? (
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={submit}
              disabled={disabled || submitting}
              className="mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-luma-gradient text-white shadow-bubble transition-all disabled:opacity-40"
              aria-label={t("send")}
            >
              <ArrowUp className="h-5 w-5" strokeWidth={2.6} />
            </motion.button>
          ) : (
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={startRecording}
              disabled={disabled || !canUpload}
              title={!canUpload ? "Voice messages require a connection" : t("recordVoice")}
              className="mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-white/10 bg-white/[0.06] text-luma-200 transition-all hover:bg-white/[0.1] disabled:opacity-40"
              aria-label={t("recordVoice")}
            >
              <Mic className="h-5 w-5" />
            </motion.button>
          )}
        </div>
      )}
    </div>
  );
}
