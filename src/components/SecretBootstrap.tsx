import { useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { ensureSecretIdentity } from "../lib/secret";

/** Publish this device's public identity so contacts can opt into secret text. */
export function SecretBootstrap() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user?.id) return;
    const initialize = () => { if (navigator.onLine) void ensureSecretIdentity(user.id).catch((error) => console.info("[Luma] secret identity unavailable:", error.message)); };
    initialize();
    window.addEventListener("online", initialize);
    return () => window.removeEventListener("online", initialize);
  }, [user?.id]);
  return null;
}
