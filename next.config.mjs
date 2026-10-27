/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Required on Next 14 for src/instrumentation.ts to be invoked.
    instrumentationHook: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals || []), 'ssh2'];
    }
    return config;
  },
};

export default nextConfig;
