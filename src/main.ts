import { start } from "./ui/app";

start();

// Register the service worker for offline/installable PWA behaviour.
// Only in production builds, so it never interferes with Vite's dev HMR.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline support unavailable - app still works online */
    });
  });
}
