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

type AuthCtx = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<{ needsConfirm: boolean }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  renameMe: (name: string) => Promise<void>;
  setAvatarPath: (path: string) => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (user: User | null) => {
    if (!user) {
      setProfile(null);
      return;
    }
    try {
      let p = await fetchProfile(user.id);
      if (!p) {
        // The signup trigger creates this row; if the project was migrated the
        // row may be missing — create a sensible fallback.
        const name =
          (user.user_metadata?.display_name as string) ||
          user.email?.split("@")[0] ||
          "Luma user";
        const { data } = await supabase
          .from("profiles")
          .upsert({ id: user.id, display_name: name }, { onConflict: "id" })
          .select("*")
          .single();
        p = (data as Profile) ?? null;
      }
      setProfile(p);
    } catch (err) {
      console.warn("[Luma] profile load failed", err);
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    let alive = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      await loadProfile(data.session?.user ?? null);
      if (alive) setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, next) => {
      setSession(next);
      await loadProfile(next?.user ?? null);
    });

    return () => {
      alive = false;
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
      signIn,
      signUp,
      signOut,
      refreshProfile,
      renameMe,
      setAvatarPath,
    }),
    [session, profile, loading, signIn, signUp, signOut, refreshProfile, renameMe, setAvatarPath]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
