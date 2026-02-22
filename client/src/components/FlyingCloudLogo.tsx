interface FlyingCloudLogoProps {
  className?: string;
  size?: number;
  showText?: boolean;
}

export function FlyingCloudLogo({ className = "", size = 40, showText = false }: FlyingCloudLogoProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Flying Cloud Technology"
      >
        <rect width="48" height="48" rx="10" fill="#1a1a2e" />

        <g transform="translate(4, 10)">
          <path
            d="M32 18H8c-3.3 0-6-2.7-6-6s2.7-6 6-6c0.2 0 0.4 0 0.6 0C10 2.6 13.2 0 17 0c4.4 0 8 3.1 8.8 7.2C26.5 7.1 27.2 7 28 7c3.3 0 6 2.7 6 6 0 0.3 0 0.7-0.1 1H34c2.2 0 4 1.8 4 4s-1.8 4-4 4h-2z"
            fill="white"
            opacity="0.95"
          />

          <path
            d="M6 22l4-3.5"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity="0.5"
          />
          <path
            d="M12 22l4-3.5"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity="0.4"
          />
          <path
            d="M18 22l4-3.5"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity="0.3"
          />

          <path
            d="M10 25l22 0"
            stroke="white"
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity="0.25"
          />
          <path
            d="M14 27.5l16 0"
            stroke="white"
            strokeWidth="1"
            strokeLinecap="round"
            opacity="0.15"
          />
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
