import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Crypto Intelligence Terminal',
  description:
    'Real-time cryptocurrency intelligence: multi-source ingestion, AI analysis, alerts and a terminal-grade timeline.',
};

export const viewport: Viewport = {
  themeColor: '#08090b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // `dark` is set on <html> rather than toggled at runtime: this UI is
  // dark-first, and the light variant is opt-in per the Tailwind config.
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
