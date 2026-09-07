import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone',
  devIndicators: false,
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ['pg'],
  experimental: { proxyClientMaxBodySize: '12mb' },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};
export default config;
