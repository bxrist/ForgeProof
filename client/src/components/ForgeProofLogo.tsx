interface ForgeProofLogoProps {
  className?: string;
  size?: number;
  variant?: "color" | "mono" | "light" | "dark";
}

export function ForgeProofLogo({ className = "", size = 24, variant = "color" }: ForgeProofLogoProps) {
  const steel = variant === "light" ? "#1e293b" : variant === "dark" ? "#e2e8f0" : variant === "mono" ? "currentColor" : "#334155";
  const steelDark = variant === "light" ? "#0f172a" : variant === "dark" ? "#f1f5f9" : variant === "mono" ? "currentColor" : "#1e293b";
  const accent = variant === "mono" ? "currentColor" : variant === "dark" ? "#60a5fa" : "#3b82f6";
  const spark = variant === "mono" ? "currentColor" : variant === "dark" ? "#f97316" : "#f59e0b";
  const sparkGlow = variant === "mono" ? "currentColor" : "#ef4444";

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
        {/* Anvil base */}
        <path
          d="M12 46 L18 42 L46 42 L52 46 Z"
          fill={steelDark}
        />
        {/* Anvil body */}
        <path
          d="M18 42 L18 36 L22 32 L42 32 L46 36 L46 42 Z"
          fill={steel}
        />
        {/* Anvil top surface */}
        <path
          d="M20 32 L44 32 L46 34 L18 34 Z"
          fill={steelDark}
          opacity="0.8"
        />
        {/* Anvil horn (left) */}
        <path
          d="M22 32 L10 36 L10 38 L18 36 L18 32 Z"
          fill={steel}
          opacity="0.85"
        />
        {/* Anvil heel (right) */}
        <path
          d="M42 32 L48 32 L48 36 L46 36 Z"
          fill={steel}
          opacity="0.75"
        />

        {/* Hammer handle */}
        <line
          x1="40" y1="28" x2="54" y2="10"
          stroke={steel}
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* Hammer head */}
        <rect
          x="49" y="5" width="12" height="7" rx="1.5"
          fill={steelDark}
          transform="rotate(35, 55, 8.5)"
        />

        {/* Impact point glow */}
        <circle cx="34" cy="30" r="4" fill={accent} opacity="0.2" />
        <circle cx="34" cy="30" r="2" fill={accent} opacity="0.35" />

        {/* Crypto sparks - hash symbols flying upward */}
        <text x="24" y="26" fontSize="5.5" fill={accent} opacity="0.9" fontFamily="monospace" fontWeight="bold">#</text>
        <text x="40" y="24" fontSize="4.5" fill={accent} opacity="0.7" fontFamily="monospace" fontWeight="bold">#</text>
        <text x="30" y="20" fontSize="5" fill={accent} opacity="0.8" fontFamily="monospace" fontWeight="bold">#</text>

        {/* Binary/hex sparks */}
        <text x="18" y="22" fontSize="4" fill={spark} opacity="0.8" fontFamily="monospace">0x</text>
        <text x="44" y="20" fontSize="3.5" fill={spark} opacity="0.6" fontFamily="monospace">f</text>
        <text x="36" y="16" fontSize="3.5" fill={sparkGlow} opacity="0.5" fontFamily="monospace">1</text>
        <text x="22" y="16" fontSize="3" fill={spark} opacity="0.5" fontFamily="monospace">a</text>

        {/* Spark dots - small particles */}
        <circle cx="28" cy="24" r="1" fill={accent} opacity="0.6" />
        <circle cx="42" cy="22" r="0.8" fill={spark} opacity="0.5" />
        <circle cx="20" cy="18" r="0.7" fill={accent} opacity="0.4" />
        <circle cx="46" cy="16" r="0.6" fill={spark} opacity="0.35" />
        <circle cx="34" cy="14" r="0.8" fill={accent} opacity="0.45" />
        <circle cx="26" cy="12" r="0.5" fill={sparkGlow} opacity="0.3" />

        {/* Base shadow line */}
        <rect x="10" y="47" width="44" height="2" rx="1" fill={steelDark} opacity="0.15" />
      </g>
    </svg>
  );
}

export function ForgeProofLogoMark({ className = "", size = 24, variant = "color" }: ForgeProofLogoProps) {
  const steel = variant === "light" ? "#1e293b" : variant === "dark" ? "#e2e8f0" : variant === "mono" ? "currentColor" : "#334155";
  const steelDark = variant === "light" ? "#0f172a" : variant === "dark" ? "#f1f5f9" : variant === "mono" ? "currentColor" : "#1e293b";
  const accent = variant === "mono" ? "currentColor" : variant === "dark" ? "#60a5fa" : "#3b82f6";
  const spark = variant === "mono" ? "currentColor" : variant === "dark" ? "#f97316" : "#f59e0b";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Background rounded square */}
      <rect x="4" y="4" width="56" height="56" rx="14" fill={steelDark} opacity="0.08" />

      <g transform="translate(2, 4)">
        {/* Anvil base */}
        <path d="M12 46 L18 42 L42 42 L48 46 Z" fill={steelDark} />
        {/* Anvil body */}
        <path d="M18 42 L18 36 L22 32 L38 32 L42 36 L42 42 Z" fill={steel} />
        {/* Anvil top */}
        <path d="M20 32 L40 32 L42 34 L18 34 Z" fill={steelDark} opacity="0.8" />
        {/* Anvil horn */}
        <path d="M22 32 L12 36 L12 38 L18 36 L18 32 Z" fill={steel} opacity="0.85" />

        {/* Hammer handle */}
        <line x1="36" y1="28" x2="50" y2="12" stroke={steel} strokeWidth="3" strokeLinecap="round" />
        {/* Hammer head */}
        <rect x="45" y="7" width="11" height="6.5" rx="1.5" fill={steelDark} transform="rotate(35, 50.5, 10)" />

        {/* Impact glow */}
        <circle cx="32" cy="30" r="3" fill={accent} opacity="0.25" />

        {/* Crypto sparks */}
        <text x="22" y="26" fontSize="5.5" fill={accent} opacity="0.85" fontFamily="monospace" fontWeight="bold">#</text>
        <text x="38" y="22" fontSize="4" fill={accent} opacity="0.65" fontFamily="monospace" fontWeight="bold">#</text>
        <text x="28" y="19" fontSize="4.5" fill={accent} opacity="0.75" fontFamily="monospace" fontWeight="bold">#</text>

        {/* Spark particles */}
        <circle cx="26" cy="22" r="0.9" fill={spark} opacity="0.6" />
        <circle cx="40" cy="18" r="0.7" fill={spark} opacity="0.5" />
        <circle cx="34" cy="14" r="0.8" fill={accent} opacity="0.4" />
      </g>
    </svg>
  );
}
