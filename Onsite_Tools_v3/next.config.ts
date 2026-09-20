import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / dynamic-require packages must stay outside the server bundle.
  serverExternalPackages: ["ssh2", "net-snmp", "better-sqlite3", "puppeteer-core", "exceljs"],
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    serverActions: { bodySizeLimit: "20mb" },
  },
};

export default nextConfig;
