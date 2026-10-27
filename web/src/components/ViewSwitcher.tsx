import { HaloSegmented } from "@/components/ui/halo-segmented";

export type ViewMode = "projects" | "orbit" | "teams";

export const VIEWS: { id: ViewMode; label: string; hint: string }[] = [
  { id: "projects", label: "项目", hint: "跨节点按项目目录聚合的会话" },
  { id: "orbit", label: "轨道", hint: "星系轨道 · 每机一圈" },
  { id: "teams", label: "团队", hint: "团队管理：成员=机器·项目目录，组长出计划自动派活" },
];

export default function ViewSwitcher({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="flex items-center gap-2">
      <HaloSegmented
        className="top-view-segmented min-w-[192px]"
        items={VIEWS.map((v) => ({
          value: v.id,
          label: <span title={`${v.label} · ${v.hint}`}>{v.label}</span>,
        }))}
        value={view}
        onValueChange={(next) => onChange(next as ViewMode)}
      />
      <span
        className="rounded-md border border-border/60 bg-surface/40 px-1.5 py-0.5 font-mono text-[10px] text-text-3"
        title="按 V 键循环切换"
      >
        V
      </span>
    </div>
  );
}
