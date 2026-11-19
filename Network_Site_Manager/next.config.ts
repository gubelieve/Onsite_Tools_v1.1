import type { NextConfig } from "next"

// Same shape as Lab_management: standalone output for the Docker run stage,
// an optional basePath for publishing behind the central nginx, no
// X-Powered-By header.
const nextConfig: NextConfig = {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  output: "standalone",
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
}

export default nextConfig
