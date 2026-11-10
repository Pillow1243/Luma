import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import "@fontsource-variable/inter";

/**
 * Capacitor serves the bundle from `https://localhost` (or `file://`), where
 * HTML5 history routing cannot resolve deep links. Hash routing keeps the
 * native shell on exactly the same component tree as the web build.
 */
const isNativeShell =
  typeof window !== "undefined" &&
  (window.location.protocol === "file:" ||
    window.location.protocol === "capacitor:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()));

const Router = isNativeShell ? HashRouter : BrowserRouter;

// Hide the boot splash once React has painted its first frame.
requestAnimationFrame(() => {
  window.setTimeout(() => document.getElementById("splash")?.classList.add("hide"), 260);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router>
      <App />
    </Router>
  </React.StrictMode>
);

// PWA service worker (registered for the web build only — Capacitor serves
// the bundle from the app package, so SW registration there is a no-op).
if (
  "serviceWorker" in navigator &&
  window.location.protocol === "https:" &&
  !isNativeShell
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline caching is a progressive enhancement */
    });
  });
}
