import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false, // the rAF game loop should not double-mount in dev
};

export default nextConfig;
