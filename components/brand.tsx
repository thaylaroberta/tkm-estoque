import Image from 'next/image';

/** Full artwork for large surfaces; a typographic monogram for compact navigation. */
export default function Brand({ hero = false }: { hero?: boolean }) {
  return (
    <div className={`brand ${hero ? 'brand-hero' : 'brand-navigation'}`}>
      <Image
        className="brand-artwork"
        src="/brand/tkm-smoke.png"
        alt="TKM SMOKE"
        width={1290}
        height={1219}
        sizes={hero ? '(max-width: 600px) 190px, (max-width: 1000px) 280px, 350px' : '190px'}
        priority
      />
      {!hero && <span className="brand-monogram" aria-label="TKM SMOKE">TKM<span>SMOKE</span></span>}
    </div>
  );
}
