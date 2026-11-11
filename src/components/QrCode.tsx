import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** QR code as an SVG path (dark modules on white, always: scanners need the contrast). */
export function QrCode({ value, size = 220, label }: { value: string; size?: number; label: string }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
    return { path: d, count: n };
  }, [value]);
  const margin = 2;
  return (
    <svg width={size} height={size} viewBox={`${-margin} ${-margin} ${count + margin * 2} ${count + margin * 2}`} role="img" aria-label={label} shapeRendering="crispEdges" className="rounded-xl bg-white">
      <rect x={-margin} y={-margin} width={count + margin * 2} height={count + margin * 2} fill="#fff" />
      <path d={path} fill="#09090b" />
    </svg>
  );
}
