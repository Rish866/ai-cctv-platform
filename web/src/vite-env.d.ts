/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute base URL of the GarudAI API (e.g. https://api.garudai.in). Set at
   * build time on Vercel. Empty in local dev (requests go same-origin via the
   * Vite proxy).
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
