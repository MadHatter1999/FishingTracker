/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  // Firebase web config (safe to expose; access is controlled by Firestore rules)
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  // Internal domain used to turn usernames into Firebase Auth emails
  readonly VITE_GUILD_EMAIL_DOMAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
