import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, Image as ImageIcon, Loader2, Paperclip, Smile, X } from "lucide-react";
import { bytes } from "../lib/format";
import type { MessageWithMeta } from "../lib/types";

const EMOJI = [
  "😀","😂","😍","🥰","😎","🤔","😅","🙌","🔥","✨","💜","❤️","👍","🙏","🎉","😭",
  "😴","🤯","🥳","😇","😤","🤝","👀","💯","🚀","🌙","☀️","🍕","☕","🎧","📎","💬",
];

export function Composer({
  onSend,
  onTyping,
  replyTo,
  onCancelReply,
  disabled,
  uploading,
  onFiles,
}: {
  onSend: (body: string) => void;
  onTyping: (typing: boolean) => void;
  replyTo?: MessageWithMeta | null;
  onCancelReply: () => void;
  disabled?: boolean;
  uploading?: { name: string; size: number } | null;
  onFiles: (files: FileList | null) => void;
}) {
  const [value, setValue] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingRef = useRef<number | null>(null);
  const lastSentRef = useRef(0);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 148)}px`;
  }, [value]);

  useEffect(() => {
    if (replyTo) taRef.current?.focus();
  }, [replyTo]);

  function handleChange(v: string) {
    setValue(v);
    const now = Date.now();
    if (now - lastSentRef.current > 2200) {
      lastSentRef.current = now;
      onTyping(true);
    }
    if (typingRef.current) window.clearTimeout(typingRef.current);
    typingRef.current = window.setTimeout(() => onTyping(false), 3200);
  }

  function submit() {
    const body = value.trim();
    if (!body) return;
    onSend(body);
    setValue("");
    setEmojiOpen(false);
    onTyping(false);
    if (typingRef.current) window.clearTimeout(typingRef.current);
  }

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
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Message…"
            className="max-h-[148px] min-h-[38px] flex-1 resize-none bg-transparent px-1 py-2 text-[14.5px] leading-[1.45] text-slate-100 placeholder-slate-500 focus:outline-none"
          />
        </div>

        <motion.button
          whileTap={{ scale: 0.92 }}
          onClick={submit}
          disabled={!value.trim() || disabled}
          className="mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-luma-gradient text-white shadow-bubble transition-all disabled:opacity-40 disabled:shadow-none"
          aria-label="Send message"
        >
          <ArrowUp className="h-5 w-5" strokeWidth={2.6} />
        </motion.button>
      </div>

      <div className="mt-1.5 hidden items-center justify-center gap-1.5 text-[10.5px] text-slate-600 sm:flex">
        <ImageIcon className="h-3 w-3" />
        Enter to send · Shift + Enter for a new line
      </div>
    </div>
  );
}
