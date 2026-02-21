interface ForgeProofLogoProps {
  className?: string;
  size?: number;
}

export function ForgeProofLogo({ className = "", size = 24 }: ForgeProofLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <g>
        <path
          d="M20 44 L44 44 L48 48 L16 48 Z"
          fill="currentColor"
          opacity="0.9"
        />
        <path
          d="M24 40 L40 40 L44 44 L20 44 Z"
          fill="currentColor"
          opacity="0.7"
        />
        <rect x="28" y="32" width="8" height="8" rx="1" fill="currentColor" opacity="0.8" />

        <path
          d="M32 32 L18 14"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          opacity="0.95"
        />
        <path
          d="M14 10 L22 18"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          opacity="0.95"
        />

        <line x1="32" y1="28" x2="26" y2="22" stroke="currentColor" strokeWidth="1.5" opacity="0.4" strokeDasharray="2 2" />
        <line x1="32" y1="28" x2="38" y2="22" stroke="currentColor" strokeWidth="1.5" opacity="0.4" strokeDasharray="2 2" />
        <line x1="32" y1="28" x2="32" y2="20" stroke="currentColor" strokeWidth="1.5" opacity="0.4" strokeDasharray="2 2" />

        <text x="26" y="21" fontSize="6" fill="currentColor" opacity="0.5" fontFamily="monospace">#</text>
        <text x="36" y="21" fontSize="6" fill="currentColor" opacity="0.5" fontFamily="monospace">#</text>
        <text x="31" y="17" fontSize="6" fill="currentColor" opacity="0.5" fontFamily="monospace">#</text>

        <circle cx="26" cy="24" r="1.5" fill="currentColor" opacity="0.35" />
        <circle cx="38" cy="24" r="1.5" fill="currentColor" opacity="0.35" />
        <circle cx="22" cy="28" r="1" fill="currentColor" opacity="0.25" />
        <circle cx="42" cy="28" r="1" fill="currentColor" opacity="0.25" />

        <rect x="16" y="50" width="32" height="3" rx="1.5" fill="currentColor" opacity="0.3" />
      </g>
    </svg>
  );
}

export function ForgeProofLogoMark({ className = "", size = 24 }: ForgeProofLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <g>
        <rect x="8" y="8" width="48" height="48" rx="12" fill="currentColor" opacity="0.1" />

        <path
          d="M20 44 L44 44 L48 48 L16 48 Z"
          fill="currentColor"
          opacity="0.9"
        />
        <path
          d="M24 40 L40 40 L44 44 L20 44 Z"
          fill="currentColor"
          opacity="0.7"
        />
        <rect x="28" y="32" width="8" height="8" rx="1" fill="currentColor" opacity="0.8" />

        <path
          d="M32 32 L18 14"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          opacity="0.95"
        />
        <path
          d="M14 10 L22 18"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          opacity="0.95"
        />

        <line x1="32" y1="28" x2="26" y2="22" stroke="currentColor" strokeWidth="1.5" opacity="0.4" strokeDasharray="2 2" />
        <line x1="32" y1="28" x2="38" y2="22" stroke="currentColor" strokeWidth="1.5" opacity="0.4" strokeDasharray="2 2" />
        <line x1="32" y1="28" x2="32" y2="20" stroke="currentColor" strokeWidth="1.5" opacity="0.4" strokeDasharray="2 2" />

        <text x="26" y="21" fontSize="6" fill="currentColor" opacity="0.5" fontFamily="monospace">#</text>
        <text x="36" y="21" fontSize="6" fill="currentColor" opacity="0.5" fontFamily="monospace">#</text>
        <text x="31" y="17" fontSize="6" fill="currentColor" opacity="0.5" fontFamily="monospace">#</text>

        <circle cx="26" cy="24" r="1.5" fill="currentColor" opacity="0.35" />
        <circle cx="38" cy="24" r="1.5" fill="currentColor" opacity="0.35" />

        <rect x="16" y="50" width="32" height="3" rx="1.5" fill="currentColor" opacity="0.3" />
      </g>
    </svg>
  );
}
