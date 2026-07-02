/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the backend Worker that hosts the API. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
