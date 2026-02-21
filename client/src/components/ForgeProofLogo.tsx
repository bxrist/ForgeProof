import logoImage from "@assets/8E0C5D6F-370B-4CC3-AC1C-F8F1C08A2A89_1771648705264.png";

interface ForgeProofLogoProps {
  className?: string;
  size?: number;
}

export function ForgeProofLogo({ className = "", size = 32 }: ForgeProofLogoProps) {
  return (
    <img
      src={logoImage}
      alt="ForgeProof"
      width={size}
      height={size}
      className={`object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export function ForgeProofLogoMark({ className = "", size = 32 }: ForgeProofLogoProps) {
  return (
    <img
      src={logoImage}
      alt="ForgeProof"
      width={size}
      height={size}
      className={`object-contain rounded-lg ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
