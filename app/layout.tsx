import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Clara · Estoque e financeiro', description: 'Uma visão clara do seu negócio.' };
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) { return <html lang="pt-BR"><body>{children}</body></html>; }
