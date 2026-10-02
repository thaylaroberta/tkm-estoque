import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'TKM SMOKE · Estoque e financeiro',
    short_name: 'TKM SMOKE',
    description: 'Estoque, compras, vendas e resultados da TKM SMOKE.',
    lang: 'pt-BR',
    start_url: '/',
    display: 'standalone',
    background_color: '#FFFFFF',
    theme_color: '#6F24D9',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
