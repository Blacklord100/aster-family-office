import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone',
  devIndicators: false,
  poweredByHeader: false,
  // OAuth callbacks contain one-time codes; do not log request URLs in development.
  logging: false,
  reactStrictMode: true,
  serverExternalPackages: ['pg'],
  experimental: { proxyClientMaxBodySize: '12mb' },
  async headers() {
    return [
      {
        // The PDF worker may parse source bytes but cannot connect to any network endpoint.
        source: '/pdfjs/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'none'; script-src 'self'; connect-src 'none'",
          },
        ],
      },
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
