import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false, // the rAF game loop should not double-mount in dev
  // The workspace packages ship TypeScript source; let Next transpile them.
  transpilePackages: ["@repo/shared", "@repo/api"],
};

export default nextConfig;
