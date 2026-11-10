import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { fetchProfile, updateProfile } from "../lib/data";
import type { Profile } from "../lib/types";
import { cacheProfile, cachedProfile } from "../lib/offline";

type AuthCtx = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  isPasswordRecovery: boolean;
  clearPasswordRecovery: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<{ needsConfirm: boolean }>;
  signOut: () => Promise<void>;
  signOutAll: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  renameMe: (name: string) => Promise<void>;
  setAvatarPath: (path: string) => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);

  const loadProfile = useCallback(async (user: User | null) => {
    if (!user) {
      setProfile(null);
      return;
    }
    try {
      if (!navigator.onLine) {
        setProfile((await cachedProfile(user.id).catch(() => undefined)) ?? null);
        return;
      }
      let p = await fetchProfile(user.id);
      if (!p) {
        const name =
          (user.user_metadata?.display_name as string) ||
          user.email?.split("@")[0] ||
          "Luma user";
        const { data } = await supabase
          .from("profiles")
          .insert({ id: user.id, display_name: name })
          .select("*")
          .maybeSingle();
        p = (data as Profile | null) ?? (await fetchProfile(user.id));
      }
      setProfile(p);
      if (p) void cacheProfile(p).catch(() => {});
    } catch (err) {
      console.warn("[Luma] profile load failed", err);
      setProfile((await cachedProfile(user.id).catch(() => undefined)) ?? null);
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    let alive = true;

    // Supabase persists the signed session locally. When offline, do not wait
    // for an expired token refresh before displaying the cached, user-scoped UI.
    const savedSession = (): Session | null => {
      try {
        const value = JSON.parse(localStorage.getItem("luma-auth") ?? "null");
        return value?.user?.id && value?.access_token ? value as Session : null;
      } catch { return null; }
    };
    if (!navigator.onLine) {
      const saved = savedSession();
      setSession(saved);
      void loadProfile(saved?.user ?? null).finally(() => { if (alive) setLoading(false); });
    } else {
      supabase.auth.getSession().then(async ({ data }) => {
        if (!alive) return;
        setSession(data.session);
        await loadProfile(data.session?.user ?? null);
        if (alive) setLoading(false);
      }).catch(() => { if (alive) setLoading(false); });
    }

    // Avoid awaiting Supabase requests inside its auth callback; the auth lock
    // can otherwise deadlock those requests. An offline token refresh must not
    // erase a locally saved session.
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (!navigator.onLine && !next && event !== "SIGNED_OUT") return;
      if (event === "PASSWORD_RECOVERY") setIsPasswordRecovery(true);
      if (event === "SIGNED_OUT") setIsPasswordRecovery(false);
      setSession(next);
      window.setTimeout(() => { if (alive) void loadProfile(next?.user ?? null); }, 0);
    });
    const reconnect = () => {
      void supabase.auth.getSession().then(({ data }) => {
        if (alive && data.session) { setSession(data.session); void loadProfile(data.session.user); }
      });
    };
    window.addEventListener("online", reconnect);

    return () => {
      alive = false;
      window.removeEventListener("online", reconnect);
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName } },
      });
      if (error) throw error;
      const needsConfirm = !data.session;
      return { needsConfirm };
    },
    []
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setSession(null);
    setIsPasswordRecovery(false);
  }, []);

  const signOutAll = useCallback(async () => {
    await supabase.auth.signOut({ scope: "global" });
    setProfile(null);
    setSession(null);
    setIsPasswordRecovery(false);
  }, []);

  const clearPasswordRecovery = useCallback(() => {
    setIsPasswordRecovery(false);
  }, []);

  const refreshProfile = useCallback(async () => {
    await loadProfile(session?.user ?? null);
  }, [loadProfile, session]);

  const renameMe = useCallback(
    async (name: string) => {
      if (!profile) return;
      const updated = await updateProfile(profile.id, {
        display_name: name.trim().slice(0, 60) || profile.display_name,
      });
      setProfile(updated);
    },
    [profile]
  );

  const setAvatarPath = useCallback(async (path: string) => {
    setProfile((p) => (p ? { ...p, avatar_path: path } : p));
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading,
      isPasswordRecovery,
      clearPasswordRecovery,
      signIn,
      signUp,
      signOut,
      signOutAll,
      refreshProfile,
      renameMe,
      setAvatarPath,
    }),
    [
      session,
      profile,
      loading,
      isPasswordRecovery,
      clearPasswordRecovery,
      signIn,
      signUp,
      signOut,
      signOutAll,
      refreshProfile,
      renameMe,
      setAvatarPath,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
