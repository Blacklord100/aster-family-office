import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
const sans = localFont({
  src: './fonts/Geist.woff2',
  variable: '--font-geist-sans',
});
const mono = localFont({
  src: './fonts/GeistMono.woff2',
  variable: '--font-geist-mono',
});
export const metadata: Metadata = {
  title: 'Aster — Family Office',
  description:
    'Your family office, connected. Private investment operations and source-linked reporting.',
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={sans.variable + ' ' + mono.variable}>{children}</body>
    </html>
  );
}
