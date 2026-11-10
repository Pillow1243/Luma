import { useEffect, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Check, Loader2, Lock } from "lucide-react";
import JoinPage from "./pages/JoinPage";
import StarredPage from "./pages/StarredPage";
import AuthPage from "./pages/AuthPage";
import MessengerPage from "./pages/MessengerPage";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { OfflineProvider } from "./context/OfflineContext";
import { CallProvider } from "./context/CallContext";
import { SecretBootstrap } from "./components/SecretBootstrap";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider, useToast } from "./context/ToastContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LumaMark } from "./components/LumaMark";
import { I18nProvider, useI18n } from "./lib/i18n";
import { isSupabaseConfigured, supabase } from "./lib/supabase";

function Booting() {
  return (
    <div className="grid h-full place-items-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex flex-col items-center gap-4"
      >
        <LumaMark size={64} className="animate-pulse drop-shadow-[0_16px_44px_rgba(139,92,246,0.6)]" />
        <span className="text-[12px] uppercase tracking-[0.28em] text-luma-300/60">Luma</span>
      </motion.div>
    </div>
  );
}

function ConfigMissing() {
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="glass-panel max-w-md rounded-3xl p-6">
        <LumaMark size={52} className="mx-auto" />
        <h1 className="mt-4 text-lg font-semibold text-white">Almost there</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-400">
          This build is missing its Supabase credentials. Set{" "}
          <code className="rounded bg-white/10 px-1.5 py-0.5 text-luma-200">VITE_SUPABASE_URL</code>{" "}
          and{" "}
          <code className="rounded bg-white/10 px-1.5 py-0.5 text-luma-200">
            VITE_SUPABASE_ANON_KEY
          </code>{" "}
          and rebuild.
        </p>
      </div>
    </div>
  );
}

function PasswordRecoveryModal() {
  const { clearPasswordRecovery } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < 8) {
      toast.push(t("passwordMinHint"), "error");
      return;
    }
    if (pw !== confirm) {
      toast.push(t("passwordsMismatch"), "error");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      toast.push(t("passwordUpdated"), "success");
      clearPasswordRecovery();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not update password", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/75 p-4 backdrop-blur-md">
      <motion.form
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        onSubmit={onSave}
        className="glass-panel w-full max-w-sm rounded-3xl p-6"
      >
        <div className="flex items-center gap-2.5 text-white">
          <Lock className="h-5 w-5 text-luma-300" />
          <h2 className="text-[16px] font-semibold">{t("setNewPassword")}</h2>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <label className="label" htmlFor="recovery-pw">{t("newPassword")}</label>
            <input
              id="recovery-pw"
              type="password"
              className="field"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              minLength={8}
              placeholder={t("passwordMinHint")}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="recovery-pw2">{t("confirmPassword")}</label>
            <input
              id="recovery-pw2"
              type="password"
              className="field"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={8}
              required
            />
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={clearPasswordRecovery}
            className="btn-ghost flex-1 py-2.5 text-[13px]"
          >
            {t("cancel")}
          </button>
          <button type="submit" disabled={busy} className="btn-primary flex-1 py-2.5 text-[13px]">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {t("savePassword")}
          </button>
        </div>
      </motion.form>
    </div>
  );
}

function Shell() {
  const { user, loading, isPasswordRecovery } = useAuth();
  const location = useLocation();

  useEffect(() => {
    document.title = user ? "Luma — Messenger" : "Luma — Light up your conversations";
  }, [user, location.pathname]);

  useEffect(() => {
    if (
      location.pathname.startsWith("/join/") &&
      sessionStorage.getItem("luma-after-auth") === location.pathname
    ) {
      sessionStorage.removeItem("luma-after-auth");
    }
  }, [location.pathname]);

  if (!user && location.pathname.startsWith("/join/")) {
    sessionStorage.setItem("luma-after-auth", location.pathname);
  }
  const afterAuth = sessionStorage.getItem("luma-after-auth");

  if (!isSupabaseConfigured) return <ConfigMissing />;
  if (loading) return <Booting />;

  return (
    <div className="h-full w-full">
      {isPasswordRecovery && user && <PasswordRecoveryModal />}
      <AnimatePresence mode="wait">
        {!user ? (
          <motion.div
            key="auth"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full overflow-y-auto"
          >
            <Routes>
              <Route path="*" element={<AuthPage />} />
            </Routes>
          </motion.div>
        ) : (
          <motion.div
            key="app"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            {afterAuth && afterAuth !== location.pathname && location.pathname === "/" ? (
              <Navigate to={afterAuth} replace />
            ) : (
              <Routes>
                <Route path="/" element={<MessengerPage />} />
                <Route path="/chat/:chatId" element={<MessengerPage />} />
                <Route path="/starred" element={<StarredPage />} />
                <Route path="/join/:token" element={<JoinPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <I18nProvider>
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>
              <OfflineProvider>
                <CallProvider>
                  <SecretBootstrap />
                  <MotionConfig reducedMotion="user">
                    <Shell />
                  </MotionConfig>
                </CallProvider>
              </OfflineProvider>
            </AuthProvider>
          </ToastProvider>
        </ThemeProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}
