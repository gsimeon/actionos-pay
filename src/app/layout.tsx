import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ActionOS Pay — Governed AI Procurement',
  description: 'Turn business intent into approved, auditable PayPal sandbox payments.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
