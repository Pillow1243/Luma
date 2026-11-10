import { useState } from "react";
import { Flag, Loader2 } from "lucide-react";
import { Modal } from "./Modal";

const REASONS = ["Spam", "Harassment or abuse", "Hate or discrimination", "Illegal content", "Impersonation", "Other"];

export function ReportModal({
  open,
  onClose,
  title,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  onSubmit: (reason: string, details: string) => Promise<void>;
}) {
  const [reason, setReason] = useState(REASONS[0]);
  const [details, setDetails] = useState("");
  const [sending, setSending] = useState(false);

  async function submit() {
    setSending(true);
    try {
      await onSubmit(reason, details.trim());
      setDetails("");
      setReason(REASONS[0]);
      onClose();
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Report"
      subtitle={title}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-ghost px-4">Cancel</button>
          <button onClick={submit} disabled={sending} className="btn-primary px-5">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}
            Submit report
          </button>
        </div>
      }
    >
      <label className="label" htmlFor="report-reason">Reason</label>
      <select
        id="report-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="field"
      >
        {REASONS.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
      <label className="label mt-4" htmlFor="report-details">Details (optional)</label>
      <textarea
        id="report-details"
        rows={3}
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        className="field resize-none"
        placeholder="What happened?"
        maxLength={800}
      />
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        Reports go to the chat administrators. Abuse of the report system may be sanctioned.
      </p>
    </Modal>
  );
}
