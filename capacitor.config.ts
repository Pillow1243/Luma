import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Luma mobile shell.
 *
 * Production (default): the WebView loads the live Vercel deployment, so the
 * APK always ships the latest UI without a store release.
 *
 * Offline/dev: set LUMA_SERVER_URL=http://10.0.2.2:5173 (Android emulator) or
 * your LAN IP before `npx cap sync` to point at a local dev server.
 */
const serverUrl = process.env.LUMA_SERVER_URL || "https://luma-messenger-chi.vercel.app";

const config: CapacitorConfig = {
  appId: "app.luma.messenger",
  appName: "Luma",
  webDir: "dist",
  bundledWebRuntime: false,
  backgroundColor: "#0b0716",
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    backgroundColor: "#0b0716",
  },
  server: {
    url: serverUrl,
    cleartext: serverUrl.startsWith("http://"),
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
