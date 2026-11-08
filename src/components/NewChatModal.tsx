import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Check, Loader2, Search, Users } from "lucide-react";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";
import { searchProfiles, createChat } from "../lib/data";
import type { Profile } from "../lib/types";
import { useToast } from "../context/ToastContext";

export function NewChatModal({
  open,
  onClose,
  meId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  meId: string;
  onCreated: (chatId: string) => void;
}) {
  const [term, setTerm] = useState("");
  const [people, setPeople] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [groupName, setGroupName] = useState("");
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      searchProfiles(term, meId)
        .then((rows) => alive && setPeople(rows))
        .catch(() => alive && setPeople([]))
        .finally(() => alive && setLoading(false));
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [term, open, meId]);

  useEffect(() => {
    if (!open) {
      setSelected([]);
      setTerm("");
      setGroupName("");
    }
  }, [open]);

  const isGroup = selected.length > 1;
  const canCreate = selected.length > 0 && (!isGroup || groupName.trim().length > 0);

  const sorted = useMemo(
    () =>
      [...people].sort((a, b) => {
        const sa = selected.some((s) => s.id === a.id) ? 0 : 1;
        const sb = selected.some((s) => s.id === b.id) ? 0 : 1;
        return sa - sb || a.display_name.localeCompare(b.display_name);
      }),
    [people, selected]
  );

  function toggle(p: Profile) {
    setSelected((s) =>
      s.some((x) => x.id === p.id) ? s.filter((x) => x.id !== p.id) : [...s, p]
    );
  }

  async function create() {
    if (!canCreate) return;
    setCreating(true);
    try {
      const id = await createChat(
        selected.map((p) => p.id),
        isGroup ? groupName.trim() : undefined
      );
      toast.push(isGroup ? "Group created" : "Conversation started", "success");
      onCreated(id);
      onClose();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not create chat", "error");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New conversation"
      subtitle="Pick one person for a direct message, or several to make a group."
      maxWidth="max-w-lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-slate-500">
            {selected.length === 0
              ? "Nobody selected"
              : `${selected.length} selected${isGroup ? " · group" : ""}`}
          </span>
          <button onClick={create} disabled={!canCreate || creating} className="btn-primary px-5">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
            {isGroup ? "Create group" : "Start chat"}
          </button>
        </div>
      }
    >
      {isGroup && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="mb-3">
          <label className="label" htmlFor="group-name">
            Group name
          </label>
          <input
            id="group-name"
            className="field"
            placeholder="e.g. Weekend plans"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            maxLength={80}
          />
        </motion.div>
      )}

      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          className="field pl-11"
          placeholder="Search people by name…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          autoFocus
        />
      </div>

      {selected.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {selected.map((p) => (
            <button
              key={p.id}
              onClick={() => toggle(p)}
              className="chip hover:border-rose-400/40 hover:text-rose-200"
            >
              {p.display_name}
              <Check className="h-3 w-3" />
            </button>
          ))}
        </div>
      )}

      <div className="max-h-[46vh] space-y-1 overflow-y-auto pr-1 no-scrollbar">
        {loading && (
          <div className="flex items-center justify-center py-8 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {!loading && sorted.length === 0 && (
          <p className="py-8 text-center text-[13px] text-slate-500">
            No people found. Invite a friend to sign up, then search again.
          </p>
        )}
        {sorted.map((p) => {
          const isSel = selected.some((s) => s.id === p.id);
          return (
            <button
              key={p.id}
              onClick={() => toggle(p)}
              className={`flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors ${
                isSel ? "bg-luma-500/15" : "hover:bg-white/[0.06]"
              }`}
            >
              <Avatar profile={p} size={40} />
              <span className="min-w-0 flex-1 truncate text-[14px] text-slate-200">
                {p.display_name}
              </span>
              <span
                className={`grid h-5 w-5 place-items-center rounded-full border transition-colors ${
                  isSel
                    ? "border-luma-400 bg-luma-500 text-white"
                    : "border-white/20 text-transparent"
                }`}
              >
                <Check className="h-3 w-3" />
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
