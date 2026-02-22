interface FlyingCloudLogoProps {
  className?: string;
  size?: number;
  showText?: boolean;
}

export function FlyingCloudLogo({ className = "", size = 40, showText = false }: FlyingCloudLogoProps) {
  const width = size * 2.2;
  const height = size;
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg
        width={width}
        height={height}
        viewBox="0 0 88 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Flying Cloud Technology + ForgeProof"
      >
        <g transform="translate(0, 2)">
          <path
            d="M18 4L18 30"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M18 4C18 4 30 5 32 12C34 19 22 20 18 18"
            fill="currentColor"
            opacity="0.9"
          />
          <path
            d="M18 10C18 10 28 11 29 16C30 21 20 21 18 18"
            fill="currentColor"
            opacity="0.7"
          />
          <path
            d="M18 6L5 10C5 10 3 10.5 4 11.5C5 12.5 8 12 8 12L18 9"
            fill="currentColor"
            opacity="0.85"
          />
          <path
            d="M18 12L7 15C7 15 4 15.8 5 17C6 18.2 9 17 9 17L18 14"
            fill="currentColor"
            opacity="0.65"
          />
          <path
            d="M6 30L32 30"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M8 32.5L30 32.5"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
            opacity="0.5"
          />
          <path
            d="M10 30C10 28 12 26 15 26C15 26 16 24.5 18 24.5C20 24.5 21 26 21 26C24 26 26 28 26 30"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="currentColor"
            opacity="0.3"
          />
        </g>

        <line x1="42" y1="6" x2="42" y2="34" stroke="currentColor" strokeWidth="0.8" opacity="0.25" />

        <g transform="translate(48, 2)">
          <path
            d="M18 28C18 28 16 27 15 26C14 25 14 24 14 24L14 22L12 22C11 22 10.5 21 11 20L14 16L16 16L18 14"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <path
            d="M18 14L20 10L24 6L28 4L30 4L30 6L28 8L24 10L22 14L20 16L18 18"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <rect
            x="26" y="3" width="5" height="4" rx="1"
            fill="currentColor"
            opacity="0.4"
            transform="rotate(-35, 28, 5)"
          />
          <path
            d="M14 24C14 24 12 25 11 26C10 27 10 28 11 29C12 30 14 29 14 29"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            fill="none"
          />
          <circle cx="13" cy="22" r="1.2" fill="currentColor" opacity="0.5" />
          <path
            d="M16 16L14 16L12 18L11.5 19.5L12.5 20.5L14 20L16 18"
            fill="currentColor"
            opacity="0.3"
          />
          <path
            d="M8 32L30 32"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
            opacity="0.3"
          />
          <rect x="12" y="30" width="14" height="2.5" rx="1" fill="currentColor" opacity="0.2" />
        </g>
      </svg>
      {showText && (
        <div className="flex flex-col leading-tight">
          <span className="font-display font-bold text-sm tracking-tight">Flying Cloud</span>
          <span className="text-[10px] text-muted-foreground tracking-wide uppercase">Technology</span>
        </div>
      )}
    </div>
  );
}

export function FlyingCloudWordmark({ className = "" }: { className?: string }) {
  return (
    <a
      href="https://www.flyingcloudtech.com"
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center gap-2 group ${className}`}
      data-testid="link-flying-cloud"
    >
      <FlyingCloudLogo size={28} />
      <div className="flex flex-col leading-tight">
        <span className="font-display font-semibold text-xs tracking-tight group-hover:text-primary transition-colors">Flying Cloud</span>
        <span className="text-[9px] text-muted-foreground tracking-wide uppercase">Technology</span>
      </div>
    </a>
  );
}
