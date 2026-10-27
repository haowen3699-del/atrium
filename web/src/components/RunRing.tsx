/** 运行中卡片的绕边框流动光圈：SVG 描边跑马灯，pathLength 归一化 → 沿真实周长等速旋转一整圈 */
export default function RunRing({ className = "", delay = 0 }: { className?: string; delay?: number }) {
  return (
    <svg className={`runring ${className}`} aria-hidden="true">
      <rect x="1" y="1" rx="27" ry="27" pathLength={100} style={delay ? { animationDelay: `${delay}s` } : undefined} />
    </svg>
  );
}