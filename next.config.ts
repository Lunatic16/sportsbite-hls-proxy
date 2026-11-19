import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Overridable so a second dev instance (tests) can run beside the main one.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
