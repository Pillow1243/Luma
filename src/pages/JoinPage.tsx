import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { CheckCircle2, Loader2, ShieldAlert } from "lucide-react";
import { Aurora } from "../components/Aurora";
import { LumaMark } from "../components/LumaMark";
import { redeemInvite } from "../lib/data";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";

export default function JoinPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [state, setState] = useState<"working" | "error">("working");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    if (!token) {
      setState("error");
      setError("This invite link is missing its token.");
      return;
    }
    redeemInvite(token)
      .then((chatId) => {
        if (!alive) return;
        toast.push("You're in! Opening the conversation…", "success");
        navigate(`/chat/${chatId}`, { replace: true });
      })
      .catch((err) => {
        if (!alive) return;
        setState("error");
        setError(
          err instanceof Error && err.message
            ? err.message
            : "This invite is invalid, expired, or already fully used."
        );
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user?.id]);

  return (
    <div className="relative grid h-full w-full place-items-center overflow-hidden">
      <Aurora />
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass-panel relative z-10 w-full max-w-sm rounded-[28px] p-7 text-center"
      >
        <LumaMark size={64} className="mx-auto drop-shadow-[0_12px_36px_rgba(139,92,246,0.55)]" />
        {state === "working" ? (
          <>
            <h1 className="mt-5 text-[17px] font-semibold text-white">Joining conversation…</h1>
            <p className="mt-1.5 text-[13px] text-slate-400">Validating your invite link.</p>
            <Loader2 className="mx-auto mt-4 h-6 w-6 animate-spin text-luma-300" />
          </>
        ) : (
          <>
            <ShieldAlert className="mx-auto mt-5 h-9 w-9 text-rose-300" />
            <h1 className="mt-4 text-[17px] font-semibold text-white">Can’t join</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-400">{error}</p>
            <button onClick={() => navigate("/")} className="btn-primary mt-5 w-full">
              <CheckCircle2 className="h-4 w-4" />
              Back to Luma
            </button>
          </>
        )}
      </motion.div>
    </div>
  );
}
