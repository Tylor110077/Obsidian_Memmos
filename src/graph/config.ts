/** 图谱设置：与 Obsidian 原生图谱设置一一对应 */

export interface ColorGroup {
  query: string;
  color: string;
}

export interface GraphSettings {
  /** 配置版本：默认值变更时递增，旧版本配置将被重置 */
  version: number;
  // 过滤器
  search: string;
  showTags: boolean;
  showAttachments: boolean;
  existingOnly: boolean;
  // 分组着色
  groups: ColorGroup[];
  // 力学
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
  // 显示
  nodeSize: number;
  linkThickness: number;
  textFade: number;
  arrows: boolean;
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  version: 8,
  search: '',
  showTags: false,
  showAttachments: false,
  existingOnly: true,
  groups: [],
  // 力学默认值对齐 Obsidian 原生图谱官方默认：向心力 0.52 / 排斥力 10 / 吸引力 1 / 连线长度 250
  centerForce: 0.52,
  repelForce: 10,
  linkForce: 1,
  linkDistance: 250,
  nodeSize: 3,
  linkThickness: 0.8,
  // 文字淡化阈值：缩放到 4.2 倍才开始显现，再放大 0.6 跨度内逐渐变清晰（用户要求出字阈值再 ×1.5：2.8 → 4.2）
  textFade: 4.2,
  arrows: false,
};
