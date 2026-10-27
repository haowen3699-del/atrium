import { memo } from "react";
import { Cast } from "../lib/iching.js";

/** 卦画迷你版：六爻竖排渲染在球心 */
export function HexGlyph({ cast, className = "orb-hex", color }: { cast: Cast | null; className?: string; color?: string }) {
  if (!cast) return null;
  const top = cast.lines.slice().reverse();
  return (
    <span className={`${className}${cast.moving.length ? " has-move" : ""}`} aria-label={cast.hex.name} style={color ? ({ ["--c" as any]: color }) : undefined}>
      {top.map((v, i) => {
        const realIdx = 5 - i;
        const moving = cast.moving.includes(realIdx + 1);
        return <i key={i} className={`hex-l${v}${moving ? "m" : ""}`} />;
      })}
    </span>
  );
}

export default memo(HexGlyph);