import type { Metadata, Viewport } from 'next';
import './globals.css';
import './brand.css';

export const metadata: Metadata = {
  title: 'TKM SMOKE · Estoque e financeiro',
  description: 'Seu espaço de gestão: estoque, vendas, entregas e resultados da TKM SMOKE.',
  applicationName: 'TKM SMOKE',
  appleWebApp: { capable: true, title: 'TKM SMOKE', statusBarStyle: 'default' },
};
export const viewport: Viewport = { themeColor: '#6F24D9' };
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
