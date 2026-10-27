import { motion } from "framer-motion";

export interface BallMenuItem {
  key: string;
  label: string;
  title?: string;
  danger?: boolean;
  active?: boolean;
  onClick: () => void;
}

const RADIUS = 88;

export default function BallRadialMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: BallMenuItem[];
  onClose: () => void;
}) {
  const cx = Math.max(RADIUS + 16, Math.min(x, window.innerWidth - RADIUS - 16));
  const cy = Math.max(RADIUS + 16, Math.min(y, window.innerHeight - RADIUS - 16));
  return (
    <div className="ball-radial-layer" onClick={(e) => { e.stopPropagation(); onClose(); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}>
      <div className="ball-radial" style={{ left: cx, top: cy }}>
        <span className="ball-radial-ring" />
        {items.map((it, i) => {
          const angle = (-90 + (360 / items.length) * i) * Math.PI / 180;
          const ix = Math.cos(angle) * RADIUS;
          const iy = Math.sin(angle) * RADIUS;
          return (
            <motion.button
              key={it.key}
              className={`ball-radial-i ${it.danger ? "danger" : ""} ${it.active ? "active" : ""}`}
              title={it.title || it.label}
              initial={{ opacity: 0, scale: 0.4, x: 0, y: 0 }}
              animate={{ opacity: 1, scale: 1, x: ix, y: iy }}
              exit={{ opacity: 0, scale: 0.5, x: ix, y: iy }}
              transition={{ duration: 0.18, delay: i * 0.015 }}
              onClick={(e) => { e.stopPropagation(); it.onClick(); onClose(); }}
            >
              {it.label}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
