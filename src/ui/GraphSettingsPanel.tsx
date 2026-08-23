import type { GraphSettings, ColorGroup } from '../graph/config';

interface Props {
  settings: GraphSettings;
  onChange: (patch: Partial<GraphSettings>) => void;
  onClose: () => void;
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  // 数值化显示（同原生图谱）：整数步进显示整数，小数步进显示两位小数（0.52 / 10.00）
  const display = step >= 1 ? String(Math.round(value)) : value.toFixed(2);
  return (
    <div className="mg-row">
      <div className="mg-row-label">
        <span>{label}</span>
        <span className="mg-row-value">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="mg-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/**
 * 图谱设置面板：结构对齐 Obsidian 原生图谱设置
 * 过滤器 / 分组 / 显示 / 力学
 */
export function GraphSettingsPanel({ settings, onChange, onClose }: Props) {
  const setGroup = (i: number, patch: Partial<ColorGroup>) => {
    const groups = settings.groups.map((g, idx) => (idx === i ? { ...g, ...patch } : g));
    onChange({ groups });
  };

  return (
    <div className="mg-panel">
      <div className="mg-panel-head">
        <span>图谱设置</span>
        <button className="mg-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>

      {/* 过滤器 */}
      <div className="mg-section">
        <div className="mg-section-title">过滤器</div>
        <input
          className="mg-search"
          type="text"
          placeholder="搜索..."
          value={settings.search}
          onChange={(e) => onChange({ search: e.target.value })}
        />
        <Check label="标签" checked={settings.showTags} onChange={(v) => onChange({ showTags: v })} />
        <Check label="附件" checked={settings.showAttachments} onChange={(v) => onChange({ showAttachments: v })} />
        <Check label="仅现有文件" checked={settings.existingOnly} onChange={(v) => onChange({ existingOnly: v })} />
      </div>

      {/* 分组 */}
      <div className="mg-section">
        <div className="mg-section-title">分组</div>
        {settings.groups.map((g, i) => (
          <div className="mg-group-row" key={i}>
            <input
              type="color"
              value={g.color}
              onChange={(e) => setGroup(i, { color: e.target.value })}
            />
            <input
              type="text"
              placeholder="查询语句..."
              value={g.query}
              onChange={(e) => setGroup(i, { query: e.target.value })}
            />
            <button
              className="mg-close"
              onClick={() => onChange({ groups: settings.groups.filter((_, idx) => idx !== i) })}
              aria-label="删除分组"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="mg-add-group"
          onClick={() => onChange({ groups: [...settings.groups, { query: '', color: '#e93147' }] })}
        >
          新增分组
        </button>
      </div>

      {/* 显示 */}
      <div className="mg-section">
        <div className="mg-section-title">显示</div>
        <Slider label="节点大小" value={settings.nodeSize} min={1} max={10} step={0.5} onChange={(v) => onChange({ nodeSize: v })} />
        <Slider label="连线粗细" value={settings.linkThickness} min={0.5} max={5} step={0.5} onChange={(v) => onChange({ linkThickness: v })} />
        <Slider label="文字淡化阈值" value={settings.textFade} min={0} max={5} step={0.05} onChange={(v) => onChange({ textFade: v })} />
        <Check label="箭头" checked={settings.arrows} onChange={(v) => onChange({ arrows: v })} />
      </div>

      {/* 力学 */}
      <div className="mg-section">
        <div className="mg-section-title">力学</div>
        <Slider label="图谱向心力" value={settings.centerForce} min={0} max={1} step={0.01} onChange={(v) => onChange({ centerForce: v })} />
        <Slider label="节点间的排斥力" value={settings.repelForce} min={0} max={20} step={0.1} onChange={(v) => onChange({ repelForce: v })} />
        <Slider label="相连节点间的吸引力" value={settings.linkForce} min={0} max={1} step={0.01} onChange={(v) => onChange({ linkForce: v })} />
        <Slider label="连线长度" value={settings.linkDistance} min={0} max={500} step={1} onChange={(v) => onChange({ linkDistance: v })} />
      </div>
    </div>
  );
}
