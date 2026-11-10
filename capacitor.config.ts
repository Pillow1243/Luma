import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Luma mobile shell.
 *
 * Production: serve the bundled app from Capacitor's secure local origin, so
 * the same origin/IndexedDB remains available online and offline. A new APK is
 * required for web updates. For development only, LUMA_SERVER_URL may point
 * to an emulator/LAN server.
 */
const serverUrl = process.env.LUMA_SERVER_URL;

const config: CapacitorConfig = {
  appId: "app.luma.messenger",
  appName: "Luma",
  webDir: "dist",
  backgroundColor: "#0b0716",
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    backgroundColor: "#0b0716",
  },
  server: {
    ...(serverUrl ? { url: serverUrl, cleartext: serverUrl.startsWith("http://") } : {}),
    androidScheme: "https",
    allowNavigation: ["*.supabase.co", "luma-messenger-chi.vercel.app", "*.vercel.app"],
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: "#0b0716",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      androidSplashResourceName: "splash_luma",
    },
  },
};

export default config;
