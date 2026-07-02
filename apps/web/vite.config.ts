import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    // Router plugin must run before the React plugin; it generates
    // src/routeTree.gen.ts from the files in src/routes.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // The workspace packages ship TS source; let Vite transpile them as source
  // rather than pre-bundling them as opaque deps.
  optimizeDeps: {
    exclude: ["@repo/shared", "@repo/api"],
  },
  server: {
    port: 3000,
    // Allow importing files from the monorepo root (packages/*).
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
});
