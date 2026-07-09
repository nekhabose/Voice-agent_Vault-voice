/** @type {import('next').NextConfig} */
const nextConfig = {
  // The workspace packages ship TypeScript source, not build output. One less
  // build step, and the dashboard always reflects the real domain types.
  transpilePackages: [
    "@ledgerline/contracts",
    "@ledgerline/conversation",
    "@ledgerline/telemetry",
  ],

  webpack: (config) => {
    // Those packages use ESM-correct `./slots.js` specifiers that resolve to
    // `./slots.ts` on disk. Node and tsc understand that; webpack needs telling.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },

  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"],
  },
};

export default nextConfig;
