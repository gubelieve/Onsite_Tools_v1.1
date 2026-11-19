import type { NextConfig } from "next"

// Same shape as Lab_management: standalone output for the Docker run stage,
// an optional basePath for publishing behind the central nginx, no
// X-Powered-By header.
const nextConfig: NextConfig = {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  output: "standalone",
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  experimental: {
    // Import configuration sends whole running-configs to a Server Action:
    // up to 50 files of at most 2 MB each are validated in the action, and
    // a typical config is 20-200 KB, so the 1 MB default would refuse a
    // batch of a few large core-switch configs.
    serverActions: { bodySizeLimit: "20mb" },
  },
}

export default nextConfig
