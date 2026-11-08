import { useId } from "react";

/**
 * The Luma brand mark: a rounded conversation bubble with a central spark.
 * Pure SVG so it stays razor-sharp at any size, on web and in the APK.
 */
export function LumaMark({
  size = 40,
  className = "",
  rounded = true,
}: {
  size?: number;
  className?: string;
  rounded?: boolean;
}) {
  const g = useId().replace(/[:]/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-label="Luma"
      role="img"
    >
      <defs>
        <linearGradient id={`bg-${g}`} x1="6" y1="2" x2="58" y2="62" gradientUnits="userSpaceOnUse">
          <stop stopColor="#241543" />
          <stop offset="1" stopColor="#0B0716" />
        </linearGradient>
        <linearGradient id={`bub-${g}`} x1="14" y1="12" x2="52" y2="50" gradientUnits="userSpaceOnUse">
          <stop stopColor="#C4B5FD" />
          <stop offset="0.45" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#5B21B6" />
        </linearGradient>
        <radialGradient id={`glow-${g}`} cx="0.5" cy="0.42" r="0.55">
          <stop stopColor="#F5F0FF" stopOpacity="0.95" />
          <stop offset="1" stopColor="#F5F0FF" stopOpacity="0" />
        </radialGradient>
      </defs>

      {rounded && (
        <rect x="0" y="0" width="64" height="64" rx="15" fill={`url(#bg-${g})`} />
      )}

      {/* bubble */}
      <path
        d="M32 11.5c-10.77 0-19.5 7.83-19.5 17.5 0 5.05 2.4 9.58 6.22 12.74-.34 3.2-1.62 5.86-3.55 7.86-.6.62-.2 1.66.65 1.75 4.35.44 7.86-.72 10.3-2.42 1.86.5 3.83.77 5.88.77 10.77 0 19.5-7.83 19.5-17.5S42.77 11.5 32 11.5Z"
        fill={`url(#bub-${g})`}
      />
      <path
        d="M32 11.5c-10.77 0-19.5 7.83-19.5 17.5 0 5.05 2.4 9.58 6.22 12.74-.34 3.2-1.62 5.86-3.55 7.86-.6.62-.2 1.66.65 1.75 4.35.44 7.86-.72 10.3-2.42 1.86.5 3.83.77 5.88.77 10.77 0 19.5-7.83 19.5-17.5S42.77 11.5 32 11.5Z"
        fill={`url(#glow-${g})`}
        opacity="0.35"
      />

      {/* spark */}
      <path
        d="M32 19.6c.55 4.42 1.42 6.28 3.05 7.68 1.5 1.29 3.66 1.9 7.35 2.42-3.69.52-5.85 1.13-7.35 2.42-1.63 1.4-2.5 3.26-3.05 7.68-.55-4.42-1.42-6.28-3.05-7.68-1.5-1.29-3.66-1.9-7.35-2.42 3.69-.52 5.85-1.13 7.35-2.42 1.63-1.4 2.5-3.26 3.05-7.68Z"
        fill="#FFFDF7"
      />
    </svg>
  );
}

export function LumaWordmark({ size = 34 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <LumaMark size={size} className="drop-shadow-[0_6px_18px_rgba(139,92,246,0.55)]" />
      <div className="leading-none">
        <div className="text-[19px] font-semibold tracking-tight text-white">Luma</div>
        <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.2em] text-luma-300/70">
          messenger
        </div>
      </div>
    </div>
  );
}
