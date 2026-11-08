import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Eye, EyeOff, Loader2, Mail, Lock, Sparkles, User } from "lucide-react";
import { Aurora } from "../components/Aurora";
import { LumaMark } from "../components/LumaMark";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { isSupabaseConfigured } from "../lib/supabase";

const FEATURES = [
  { title: "Realtime", body: "Messages land instantly over websockets." },
  { title: "Glassmorphic", body: "A dark, luminous interface built for focus." },
  { title: "Reactions & media", body: "Photos, files and emoji on every message." },
];

export default function AuthPage() {
  const { signIn, signUp } = useAuth();
  const toast = useToast();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isSupabaseConfigured) {
      toast.push("Supabase is not configured for this build.", "error");
      return;
    }
    setBusy(true);
    try {
      if (mode === "signin") {
        await signIn(email.trim(), password);
        toast.push("Welcome back to Luma", "success");
      } else {
        const { needsConfirm } = await signUp(email.trim(), password, displayName.trim());
        if (needsConfirm) {
          setConfirmSent(true);
        } else {
          toast.push("Account created — you're in", "success");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      toast.push(msg.replace(/^.*?:\s*/, ""), "error");
    } finally {
      setBusy(false);
    }
  }

  function useDemo() {
    // Convenience for quick multi-account testing without an SMTP server.
    const n = Math.floor(Math.random() * 9000) + 1000;
    setMode("signup");
    setEmail(`luma.test${n}@example.com`);
    setPassword("luma12345");
    setDisplayName(`Guest ${n}`);
  }

  return (
    <div className="relative flex min-h-full flex-col lg:flex-row">
      <Aurora />

      {/* ---------------------------- brand column --------------------------- */}
      <aside className="relative hidden flex-1 flex-col justify-between overflow-hidden p-12 lg:flex">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="flex items-center gap-3"
        >
          <LumaMark size={46} className="drop-shadow-[0_10px_30px_rgba(139,92,246,0.6)]" />
          <div>
            <div className="text-2xl font-semibold tracking-tight text-white">Luma</div>
            <div className="text-[11px] uppercase tracking-[0.25em] text-luma-300/70">
              messenger
            </div>
          </div>
        </motion.div>

        <div className="relative max-w-lg">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.08 }}
            className="text-5xl font-semibold leading-[1.06] tracking-tight text-white"
          >
            Light up your
            <br />
            <span className="text-gradient">conversations.</span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.16 }}
            className="mt-5 text-[15px] leading-relaxed text-slate-400"
          >
            Luma is a premium realtime messenger — instant delivery, read receipts,
            reactions and media, wrapped in a dark glassmorphic interface that never
            gets in your way.
          </motion.p>

          <div className="mt-10 grid gap-3">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, x: -14 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.55, delay: 0.24 + i * 0.09 }}
                className="glass flex items-start gap-3 rounded-2xl px-4 py-3"
              >
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-luma-300" />
                <div>
                  <div className="text-sm font-medium text-white">{f.title}</div>
                  <div className="text-[13px] text-slate-400">{f.body}</div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        <div className="text-[12px] text-slate-600">
          © {new Date().getFullYear()} Luma · Built for the web and Android
        </div>
      </aside>

      {/* ----------------------------- form column --------------------------- */}
      <main className="relative flex flex-1 items-center justify-center p-5 sm:p-8">
        <motion.div
          initial={{ opacity: 0, y: 18, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.55, ease: [0.2, 0.8, 0.2, 1] }}
          className="glass-panel w-full max-w-[26rem] rounded-[30px] p-6 sm:p-8"
        >
          <div className="relative z-10">
            <div className="mb-7 flex flex-col items-center text-center lg:hidden">
              <LumaMark size={62} className="drop-shadow-[0_14px_38px_rgba(139,92,246,0.6)]" />
              <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white">Luma</h1>
              <p className="mt-1 text-[13px] text-slate-400">Light up your conversations</p>
            </div>

            <div className="mb-6 hidden lg:block">
              <h2 className="text-[22px] font-semibold tracking-tight text-white">
                {mode === "signin" ? "Welcome back" : "Create your account"}
              </h2>
              <p className="mt-1 text-[13px] text-slate-400">
                {mode === "signin"
                  ? "Sign in to pick up where you left off."
                  : "It takes about ten seconds. No email confirmation needed."}
              </p>
            </div>

            {/* segmented control */}
            <div className="relative mb-6 flex rounded-2xl border border-white/10 bg-white/[0.04] p-1">
              {(["signin", "signup"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setConfirmSent(false);
                  }}
                  className="relative z-10 flex-1 rounded-xl px-3 py-2 text-[13px] font-semibold transition-colors"
                >
                  {mode === m && (
                    <motion.span
                      layoutId="auth-seg"
                      className="absolute inset-0 -z-10 rounded-xl bg-luma-gradient shadow-bubble"
                      transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className={mode === m ? "text-white" : "text-slate-400"}>
                    {m === "signin" ? "Sign in" : "Sign up"}
                  </span>
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait">
              {confirmSent ? (
                <motion.div
                  key="confirm"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-4 text-[13px] leading-relaxed text-emerald-200"
                >
                  <div className="mb-1 font-semibold text-emerald-100">Check your inbox</div>
                  Email confirmation is required on this project, so we sent a link to{" "}
                  <span className="font-medium">{email}</span>. Open it, then sign in.
                </motion.div>
              ) : (
                <motion.form
                  key={mode}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22 }}
                  onSubmit={onSubmit}
                  className="space-y-4"
                >
                  {mode === "signup" && (
                    <div>
                      <label className="label" htmlFor="name">
                        Display name
                      </label>
                      <div className="relative">
                        <User className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                        <input
                          id="name"
                          className="field pl-11"
                          placeholder="How should people see you?"
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          autoComplete="nickname"
                          required
                          maxLength={60}
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="label" htmlFor="email">
                      Email
                    </label>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                      <input
                        id="email"
                        type="email"
                        className="field pl-11"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="email"
                        inputMode="email"
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label className="label" htmlFor="password">
                      Password
                    </label>
                    <div className="relative">
                      <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                      <input
                        id="password"
                        type={showPw ? "text" : "password"}
                        className="field px-11"
                        placeholder={mode === "signup" ? "At least 6 characters" : "••••••••"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete={mode === "signin" ? "current-password" : "new-password"}
                        minLength={6}
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPw((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-500 transition-colors hover:text-slate-300"
                        aria-label={showPw ? "Hide password" : "Show password"}
                      >
                        {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  <button type="submit" disabled={busy} className="btn-primary w-full py-3.5">
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        {mode === "signin" ? "Sign in" : "Create account"}
                        <ArrowRight className="h-4 w-4" />
                      </>
                    )}
                  </button>

                  {mode === "signup" && (
                    <button
                      type="button"
                      onClick={useDemo}
                      className="w-full text-center text-[12.5px] text-slate-500 transition-colors hover:text-luma-300"
                    >
                      Fill in a throwaway test account
                    </button>
                  )}
                </motion.form>
              )}
            </AnimatePresence>

            <div className="mt-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-white/10" />
              <span className="text-[11px] uppercase tracking-widest text-slate-600">secure</span>
              <div className="h-px flex-1 bg-white/10" />
            </div>
            <p className="mt-3 text-center text-[11.5px] leading-relaxed text-slate-600">
              Protected by Supabase Auth · Luma never stores your password in plain text.
            </p>
          </div>
        </motion.div>
      </main>
    </div>
  );
}
