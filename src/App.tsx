import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import AuthPage from "./pages/AuthPage";
import MessengerPage from "./pages/MessengerPage";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./context/ToastContext";
import { LumaMark } from "./components/LumaMark";
import { isSupabaseConfigured } from "./lib/supabase";

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

function Shell() {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Keep the document title in sync with where you are.
  useEffect(() => {
    document.title = user ? "Luma — Messenger" : "Luma — Light up your conversations";
  }, [user, location.pathname]);

  if (!isSupabaseConfigured) return <ConfigMissing />;
  if (loading) return <Booting />;

  return (
    <div className="h-full w-full">
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
            <Routes>
              <Route path="/" element={<MessengerPage />} />
              <Route path="/chat/:chatId" element={<MessengerPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <Shell />
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
