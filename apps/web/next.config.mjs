/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The workspace packages ship TypeScript source, not built output, so Next
  // must transpile them rather than treat them as prebuilt node_modules.
  transpilePackages: ['@cid/core', '@cid/platform', '@cid/db', '@cid/ai', '@cid/connectors'],

  // Keep native/Node-only packages out of the client and edge bundles.
  // (Renamed from `experimental.serverComponentsExternalPackages` in Next 15.)
  serverExternalPackages: [
    '@prisma/client',
    'prisma',
    'pino',
    'pino-pretty',
    'ioredis',
    'nodemailer',
  ],

  webpack: (config) => {
    /*
     * The shared packages use explicit `.js` extensions in their relative
     * imports (`./domain/coin.js`), which is what TypeScript's NodeNext/Bundler
     * resolution and `tsx` expect for ESM-correct source. Webpack does not apply
     * that mapping itself, so it looks for a literal `coin.js` and fails.
     *
     * `extensionAlias` tells webpack to try the TypeScript source for a `.js`
     * specifier. The alternative — dropping the extensions from the source —
     * would break Node's native ESM resolution for the worker process.
     */
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },

  eslint: {
    // Linting runs once for the whole monorepo via `npm run lint`.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Typechecking runs via `npm run typecheck`; duplicating it here doubles
    // build time for no extra signal.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
