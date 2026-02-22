import logoImage from "@assets/image_1771732757891.png";

interface FlyingCloudLogoProps {
  className?: string;
  size?: number;
  showText?: boolean;
}

export function FlyingCloudLogo({ className = "", size = 40, showText = false }: FlyingCloudLogoProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <img
        src={logoImage}
        alt="ForgeProof by Flying Cloud Technology"
        width={size}
        height={size}
        className="object-contain"
        style={{ width: size, height: size }}
      />
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
