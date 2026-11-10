import logoImage from "@assets/ForgeProof_1793921023505.png";

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
