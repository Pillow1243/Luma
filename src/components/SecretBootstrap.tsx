import { useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { ensureSecretIdentity } from "../lib/secret";

/**
 * Publish this device's X3DH identity + signed prekey + one-time prekey pool
 * and replenish one-time prekeys when online or returning to the app.
 */
export function SecretBootstrap() {
  const { user } = useAuth();
  const lastSyncRef = useRef<number>(0);

  useEffect(() => {
    if (!user?.id) return;
    const uid = user.id;

    const syncKeys = (force = false) => {
      if (!navigator.onLine) return;
      const now = Date.now();
      if (!force && now - lastSyncRef.current < 5 * 60_000) return;
      lastSyncRef.current = now;
      void ensureSecretIdentity(uid).catch((error) => {
        lastSyncRef.current = 0;
        console.info("[Luma] secret identity sync skipped:", error instanceof Error ? error.message : error);
      });
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") syncKeys(false);
    };
    const onOnline = () => syncKeys(true);

    syncKeys(true);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user?.id]);

  return null;
}
