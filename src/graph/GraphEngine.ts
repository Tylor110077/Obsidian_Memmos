import {
  forceSimulation,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import type { GNode, GLink } from './buildGraph';
import type { ColorGroup, GraphSettings } from './config';
import { parseTokens, tokensMatch, type Token } from './filter';

interface SimNode extends SimulationNodeDatum, GNode {
  radius: number;
  color?: string;
  degree: number;
}

interface SimLink {
  source: SimNode;
  target: SimNode;
}

export interface EngineCallbacks {
  onOpenNode: (node: GNode) => void;
}

interface Transform {
  x: number;
  y: number;
  k: number;
}

/** 连线长度滑块 → 像素的比例系数：滑块值是档位而非像素（同原生），
 * 直接用 250px 作弹簧长度会把星型结构撑成稀疏放射状（楔形空洞）；压到 1/5 后图紧凑填满 */
const LINK_DISTANCE_SCALE = 0.2;

/** OpenOrd 多阶段布局（VxOrd, Martin 2011 思想）：布局算法替换，视觉样式不变。
 * 阶段推进：Liquid（剪断超长边 + 强斥力把缠绕结构展平）→ Expansion（继续扩散）
 * → Cool-down（恢复全边收敛）→ Fine-tune（小步落定）
 * → Free-settle（自由伸缩：入口呼吸式回火，弹簧把边拉回自然长度，保证连线长短一致）；
 * 目标：增强斥力、削弱 hub 吸附、减少中心聚集，节点在圆形画布内均匀分布、间距一致。
 * 丝滑化（用户要求的仪式感）：阶段参数不再逐档阶跃，而在关键帧间 smoothstep 连续插值，
 * 回火改为潮汐式涨落——切换瞬间无受力突变，演变过程平滑连贯 */

/** 平滑过渡（ease-in-out）：用于阶段关键帧间的连续插值，消除阶段切换时的受力突变 */
const smoothstep = (x: number): number => x * x * (3 - 2 * x);

/** 按 tick 在关键帧间插值：首帧之前取头值，末帧之后取尾值 */
function lerpKeyframes(keys: [number, number][], t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t < keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      return v0 + (v1 - v0) * smoothstep((t - t0) / (t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

/** 斥力乘子关键帧（阶段边界值）：3（Liquid 强斥力）→ 2（Expansion）→ 1.4（Cool-down）→ 1（Fine-tune 及之后），帧间连续渐变 */
const REPEL_KEYS: [number, number][] = [
  [0, 3.0],
  [140, 2.0],
  [280, 1.4],
  [420, 1.0],
];

/** 剪边阈值关键帧：2.5 → 3.5 → 6 逐渐放宽（剪边作用渐渐淡出），CUT_END_TICK 后彻底不剪 */
const CUT_KEYS: [number, number][] = [
  [0, 2.5],
  [140, 3.5],
  [280, 6.0],
];
const CUT_END_TICK = 280;

/** 自由伸缩阶段入口：从这里开始呼吸式涨落（alphaTarget 渐升再缓退，替代瞬时 alpha 跳变） */
const FREE_SETTLE_TICK = 560;
/** 涨潮持续 tick（约 1.7 秒缓升，随后目标归零缓缓退潮至停摆） */
const SETTLE_SWELL_TICKS = 100;

/** d3 自定义力接口（只需 initialize + 每步调用） */
type LiveForce = ((alpha: number) => void) & { initialize: (nodes: SimNode[]) => void };

/** 斥力：manyBody 定律（力大小 ∝ 1/d、无限程）× 阶段斥力乘子；电荷均匀（间距一致的关键）；
 * 自研 O(n²)（600 节点量级无压力），电荷每步实时读配置（滑块即时生效） */
function makeOpenOrdCharge(getStrength: () => number, getMul: () => number): LiveForce {
  let nodes: SimNode[] = [];
  const force = ((alpha: number) => {
    const S = getStrength() * getMul();
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const ax = a.x ?? 0;
      const ay = a.y ?? 0;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = (b.x ?? 0) - ax;
        const dy = (b.y ?? 0) - ay;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1; // 软化：重叠时力不爆炸（同 d3 distanceMin 语义）
        const w = (S * alpha) / d2;
        a.vx = (a.vx ?? 0) + dx * w;
        a.vy = (a.vy ?? 0) + dy * w;
        b.vx = (b.vx ?? 0) - dx * w;
        b.vy = (b.vy ?? 0) - dy * w;
      }
    }
  }) as LiveForce;
  force.initialize = (ns) => {
    nodes = ns;
  };
  return force;
}

/** 弹簧：胡克力 + 两项 OpenOrd 式改造：
 * ① 削弱 hub 吸附：强度按两端最大度数 log 衰减（hub 的边拉得弱，减少中心聚集）；
 * ② 剪边（edge cutting）：早期阶段跳过超长边，让团块先自由展开再被边拉回；
 * 位移按 d3 的 bias 分配：连接多的一端少动（枢纽不被拉飞）；距离/强度每步实时读配置 */
function makeOpenOrdLinks(
  links: SimLink[],
  getDistance: () => number,
  getStrength: () => number,
  getCut: () => number,
): LiveForce {
  const force = ((alpha: number) => {
    const L = getDistance();
    const base = getStrength();
    const cut = getCut();
    for (const l of links) {
      const s = l.source;
      const t = l.target;
      const dx = (t.x ?? 0) - (s.x ?? 0);
      const dy = (t.y ?? 0) - (s.y ?? 0);
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-3;
      if (d > L * cut) continue; // 剪边：本步忽略超长边（OpenOrd liquid 阶段）
      const degMax = Math.max(s.degree ?? 0, t.degree ?? 0);
      const b = (base * alpha * (d - L)) / (d * (1 + Math.log(1 + degMax)));
      // bias：度数占比高的一端吸收更多位移 → hub 几乎不动，只有叶子在动（削弱 hub 吸附）
      const bias = (s.degree ?? 0) / ((s.degree ?? 0) + (t.degree ?? 0) || 1);
      t.vx = (t.vx ?? 0) - dx * b * bias;
      t.vy = (t.vy ?? 0) - dy * b * bias;
      s.vx = (s.vx ?? 0) + dx * b * (1 - bias);
      s.vy = (s.vy ?? 0) + dy * b * (1 - bias);
    }
  }) as LiveForce;
  force.initialize = () => {};
  return force;
}

/** 圆形画布围合：半径 R 内节点不受力，超出则按超出量线性推回——
 * 替代强向心力（减少中心聚集）同时保住整体圆盘外观，不让图无限扩散 */
function makeContainment(radius: number, strength: number): LiveForce {
  let nodes: SimNode[] = [];
  const force = ((alpha: number) => {
    for (const n of nodes) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const r = Math.sqrt(x * x + y * y);
      if (r <= radius) continue;
      const f = (strength * alpha * (r - radius)) / r;
      n.vx = (n.vx ?? 0) - x * f;
      n.vy = (n.vy ?? 0) - y * f;
    }
  }) as LiveForce;
  force.initialize = (ns) => {
    nodes = ns;
  };
  return force;
}

/**
 * 图谱引擎：d3-force 物理模拟 + canvas 渲染 + 交互
 * 对齐 Obsidian 原生图谱：力导向、悬停高亮、缩放标签淡化、拖拽、箭头、分组着色
 */
export class GraphEngine {
  private ctx: CanvasRenderingContext2D;
  private sim: Simulation<SimNode, undefined> | null = null;
  private nodes: SimNode[] = [];
  private links: SimLink[] = [];
  private adj = new Map<string, Set<string>>();
  // 初始缩放 2.25：0.4 → 0.75 → 1.0 → 1.5 → 2.25 用户逐步要求放大；不自动 fit，用户可随时滚轮调整
  private transform: Transform = { x: 0, y: 0, k: 2.25 };
  /** 相机聚焦动画：smoothstep 缓动过渡（focusNode 触发；用户滚轮/拖拽打断） */
  private camAnim: { t0: number; dur: number; from: Transform; to: Transform } | null = null;
  private inited = false;
  private hoverId: string | null = null;
  /** 聚焦后的粘性高亮：鼠标移动/移出不清除，只在点下空白或某个节点时取消（用户要求：
   * 定位后刚准备点周边节点时，不能因为鼠标一动就分不清哪些是周边点） */
  private stickyId: string | null = null;
  private dragNode: SimNode | null = null;
  private panStart: { x: number; y: number; tx: number; ty: number } | null = null;
  private downPos: { x: number; y: number } | null = null;
  private downNode: SimNode | null = null;
  private raf = 0;
  private dirty = true;
  private frame = 0;
  /** OpenOrd 阶段时钟：每次重建数据归零，tick 驱动阶段推进 */
  private simTick = 0;
  private ro: ResizeObserver;
  private cfg: GraphSettings;
  private groupRules: { tokens: Token[]; color: string }[] = [];
  private colors = { node: '', edge: '', highlight: '', label: '' };

  constructor(
    private canvas: HTMLCanvasElement,
    settings: GraphSettings,
    private cb: EngineCallbacks,
  ) {
    this.cfg = { ...settings };
    this.ctx = canvas.getContext('2d')!;
    this.refreshColors();

    this.ro = new ResizeObserver(() => this.resize());
    if (canvas.parentElement) this.ro.observe(canvas.parentElement);
    this.resize();

    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);

    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.sim?.stop();
    this.ro.disconnect();
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
  }

  // ===== 数据 =====

  setData(rawNodes: GNode[], rawLinks: GLink[]) {
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    const degree = new Map<string, number>();
    for (const l of rawLinks) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }

    // 叶序螺旋初始化 + 随机抖动：大体均匀铺开但打破螺旋对称性，
    // 避免快速收敛后节点冻结在螺旋弧线上（同原生图谱的均匀云团观感）
    const GOLDEN_ANGLE = 2.399963229728653;
    this.nodes = rawNodes.map((n, i) => {
      const old = prev.get(n.id);
      const spiralR = 12 * Math.sqrt(0.5 + i);
      const angle = i * GOLDEN_ANGLE;
      const jx = (Math.random() - 0.5) * 10;
      const jy = (Math.random() - 0.5) * 10;
      const node: SimNode = {
        ...n,
        degree: degree.get(n.id) ?? 0,
        x: old?.x ?? spiralR * Math.cos(angle) + jx,
        y: old?.y ?? spiralR * Math.sin(angle) + jy,
        vx: 0,
        vy: 0,
        radius: 0,
      };
      node.radius = this.radiusOf(node);
      return node;
    });

    const ids = new Set(this.nodes.map((n) => n.id));
    const input = rawLinks
      .filter((l) => ids.has(l.source) && ids.has(l.target))
      .map((l) => ({ ...l }));

    // 邻接表（悬停高亮用）
    this.adj = new Map();
    for (const l of input) {
      if (!this.adj.has(l.source)) this.adj.set(l.source, new Set());
      if (!this.adj.has(l.target)) this.adj.set(l.target, new Set());
      this.adj.get(l.source)!.add(l.target);
      this.adj.get(l.target)!.add(l.source);
    }

    // 渲染用边：按 id 解析成节点对；必须在创建模拟前构建——
    // 布局弹簧力直接引用 this.links 的节点引用，先建表再装配保证边不丢失
    const nodeById = new Map(this.nodes.map((n) => [n.id, n]));
    this.links = input
      .map((l) => ({ source: nodeById.get(l.source), target: nodeById.get(l.target) }))
      .filter((l): l is SimLink => !!l.source && !!l.target);

    this.sim?.stop();
    this.simTick = 0; // 阶段时钟归零：每次数据重建重新走一遍 OpenOrd 阶段
    // 布局算法：OpenOrd 多阶段力导向（首次实现时的快照，用户要求恢复）；视觉样式/渲染完全不变：
    // 深色背景、灰色节点与连线、节点分层大小、连接关系、圆盘外观均保留
    this.sim = forceSimulation<SimNode>(this.nodes)
      // 阻尼/衰减基线（0.32 / 0.012，慢衰减给足阶段自组织时间）
      .velocityDecay(0.32)
      .alphaDecay(0.012)
      // 斥力（增强）：manyBody 定律 × 阶段乘子（3 → 2 → 1.4 → 1）；电荷均匀 → 间距一致；
      // 电荷 = -排斥力²×1.5×0.2，默认 10 → -30（liquid 阶段等效 -90）；实时读配置
      .force(
        'charge',
        makeOpenOrdCharge(
          () => -Math.pow(this.cfg.repelForce, 2) * 1.5 * LINK_DISTANCE_SCALE,
          () => this.stage().repelMul,
        ),
      )
      // 弹簧（削弱 hub 吸附）：基础强度 = 吸引力滑块 ×0.5，按边两端最大度数 log 衰减，
      // 位移按度数 bias 分配（枢纽几乎不动）；早期阶段剪断超长边让结构先展开
      .force(
        'link',
        makeOpenOrdLinks(
          this.links,
          () => this.cfg.linkDistance * LINK_DISTANCE_SCALE,
          () => this.cfg.linkForce * 0.5,
          () => this.stage().cutFactor,
        ),
      )
      // 碰撞：统一碰撞半径（与节点视觉大小无关）强制出全局一致的间距下限，防重叠兜底
      .force('collide', forceCollide<SimNode>(() => 10).strength(0.9).iterations(2))
      // 弱向心（减少中心聚集）：只做极弱收拢，不再把外圈拽向中心压扁结构
      .force('x', forceX<SimNode>(0).strength(this.cfg.centerForce * 0.06))
      .force('y', forceY<SimNode>(0).strength(this.cfg.centerForce * 0.06))
      // 圆形画布围合：超出半径 240 按超出量推回——替代强向心保住圆盘外观，不让图无限扩散
      .force('contain', makeContainment(240, 0.08))
      // 每步推进阶段时钟 + 标记画面脏：模拟由 d3 内部计时器驱动（每帧一步）
      .on('tick', () => {
        this.simTick++;
        // 进入自由伸缩阶段：不再瞬时跳变 alpha（受力突变会跳动），改为呼吸式平滑涨落（丝滑/仪式感）：
        // alphaTarget 涨潮 → alpha 缓缓升起（约 1.7 秒）→ 到点后目标归零缓缓退潮；
        // 同时提高衰减率控制收尾总时长（衰减率是连续参数，不产生突变）
        if (this.simTick === FREE_SETTLE_TICK) {
          this.sim?.alphaDecay(0.03);
          this.sim?.alphaTarget(0.3).restart();
        } else if (this.simTick === FREE_SETTLE_TICK + SETTLE_SWELL_TICKS) {
          this.sim?.alphaTarget(0);
        }
        this.dirty = true;
      });

    this.applyGroupColors();
    this.dirty = true;
  }

  /** 实时更新显示/力学设置：滑块拖动即时生效并重新加热模拟 */
  setConfig(cfg: GraphSettings) {
    const forceChanged =
      cfg.centerForce !== this.cfg.centerForce ||
      cfg.repelForce !== this.cfg.repelForce ||
      cfg.linkForce !== this.cfg.linkForce ||
      cfg.linkDistance !== this.cfg.linkDistance ||
      cfg.nodeSize !== this.cfg.nodeSize;
    this.cfg = { ...cfg };
    if (!this.sim) return;

    if (forceChanged) {
      for (const n of this.nodes) n.radius = this.radiusOf(n);
      // 斥力/弹簧/剪边每步实时读配置，无需在此更新；只有向心需要显式同步
      this.sim.force<ReturnType<typeof forceX>>('x')!.strength(cfg.centerForce * 0.06);
      this.sim.force<ReturnType<typeof forceY>>('y')!.strength(cfg.centerForce * 0.06);
      this.sim.alpha(Math.max(this.sim.alpha(), 0.5)).restart();
    }
    this.dirty = true;
  }

  setGroups(groups: ColorGroup[]) {
    this.groupRules = groups
      .filter((g) => g.query.trim())
      .map((g) => ({ tokens: parseTokens(g.query), color: g.color }));
    this.applyGroupColors();
    this.dirty = true;
  }

  // ===== 内部 =====

  /** 当前包络参数：按 tick 在关键帧间连续插值（丝滑仪式感）——斥力乘子与剪边阈值渐变，阶段切换无受力突变 */
  private stage(): { repelMul: number; cutFactor: number } {
    return {
      repelMul: lerpKeyframes(REPEL_KEYS, this.simTick),
      cutFactor: this.simTick >= CUT_END_TICK ? Infinity : lerpKeyframes(CUT_KEYS, this.simTick),
    };
  }

  private applyGroupColors() {
    for (const n of this.nodes) {
      n.color = undefined;
      for (const rule of this.groupRules) {
        if (rule.tokens.length && tokensMatch(n, rule.tokens)) {
          n.color = rule.color;
          break;
        }
      }
    }
  }

  /** 节点半径：基础大小 × 类型系数 × 分层档系数。
   * 分层而非连接数开方（用户要求离散层级、大小有区分度）：
   * 枢纽 ≥30 连接 ×2.4 / 中坚 5–29 ×1.6 / 普通 1–4 ×1.0 / 孤立 0 ×0.7，档间比值 ≥1.4 保证视觉可辨 */
  private radiusOf(n: SimNode): number {
    const kindFactor = n.kind === 'tag' ? 0.7 : n.kind === 'attachment' ? 0.85 : n.kind === 'ghost' ? 0.8 : 1;
    const d = n.degree ?? 0;
    const tier = d >= 30 ? 2.4 : d >= 5 ? 1.6 : d >= 1 ? 1 : 0.7;
    return this.cfg.nodeSize * kindFactor * tier;
  }

  private refreshColors() {
    const cs = getComputedStyle(document.body);
    const pick = (v: string, fb: string) => cs.getPropertyValue(v).trim() || fb;
    this.colors = {
      node: pick('--text-muted', '#8b8b8b'),
      edge: pick('--text-faint', '#7a7a7a'),
      highlight: pick('--interactive-accent', '#705dcf'),
      label: pick('--text-normal', '#dcdcdc'),
    };
  }

  private resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (!this.inited) {
      this.transform.x = w / 2;
      this.transform.y = h / 2;
      this.inited = true;
    }
    this.dirty = true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    // 相机聚焦动画：smoothstep 缓动过渡到目标视角（与布局丝滑化同一条平滑曲线）
    if (this.camAnim) {
      const a = this.camAnim;
      const p = Math.min(1, (performance.now() - a.t0) / a.dur);
      const e = smoothstep(p);
      this.transform.x = a.from.x + (a.to.x - a.from.x) * e;
      this.transform.y = a.from.y + (a.to.y - a.from.y) * e;
      this.transform.k = a.from.k + (a.to.k - a.from.k) * e;
      if (p >= 1) this.camAnim = null;
      this.dirty = true;
    }
    // 物理由 d3 内部计时器驱动，每帧一步；模拟跑到 alpha 衰减到停摆线自然停止（稳定才停）
    if (!this.dirty) return;
    this.dirty = false;
    this.frame++;
    if (this.frame % 240 === 0) this.refreshColors();
    this.draw();
  };

  // ===== 渲染 =====

  private draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    const { k } = this.transform;
    const ctx = this.ctx;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(this.transform.x, this.transform.y);
    ctx.scale(k, k);

    const hovered = this.hoverId ?? this.stickyId;
    const neighbors = hovered ? this.adj.get(hovered) : undefined;
    const isActive = (id: string) => id === hovered || (neighbors?.has(id) ?? false);

    // 边（直线，可选箭头）
    for (const l of this.links) {
      const active = hovered !== null && (l.source.id === hovered || l.target.id === hovered);
      ctx.globalAlpha = hovered ? (active ? 0.9 : 0.07) : 0.5;
      ctx.strokeStyle = active ? this.colors.highlight : this.colors.edge;
      // 线宽除以缩放系数：任何缩放级别下屏幕上粗细一致
      ctx.lineWidth = this.cfg.linkThickness / k;
      ctx.beginPath();
      ctx.moveTo(l.source.x!, l.source.y!);
      ctx.lineTo(l.target.x!, l.target.y!);
      ctx.stroke();

      if (this.cfg.arrows) {
        const dx = l.target.x! - l.source.x!;
        const dy = l.target.y! - l.source.y!;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const tipX = l.target.x! - ux * l.target.radius;
        const tipY = l.target.y! - uy * l.target.radius;
        const s = (2.5 + this.cfg.linkThickness * 1.5) / k;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - ux * s - uy * s * 0.5, tipY - uy * s + ux * s * 0.5);
        ctx.lineTo(tipX - ux * s + uy * s * 0.5, tipY - uy * s - ux * s * 0.5);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 节点
    for (const n of this.nodes) {
      const active = hovered === null || isActive(n.id);
      ctx.globalAlpha = active ? (n.kind === 'ghost' ? 0.55 : 1) : 0.12;
      ctx.fillStyle = n.color || (hovered !== null && n.id === hovered ? this.colors.highlight : this.colors.node);
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 标签分三阶段：无文字 → 逐渐显现 → 完全清晰（随缩放线性淡化）
    // 悬停规则：主节点名字始终亮；相邻节点名字跟随同一淡化曲线慢慢显现（不突变）
    // 淡出区间拉长到 0.6：从无文字到完全清晰需要很大的缩放跨度，显现缓慢平滑（不突变）
    const fadeBase = Math.max(0, Math.min(1, (k - this.cfg.textFade) / 0.6));
    ctx.textAlign = 'center';
    ctx.fillStyle = this.colors.label;
    ctx.font = `${11 / k}px -apple-system, "Segoe UI", sans-serif`;
    for (const n of this.nodes) {
      let a: number;
      if (hovered !== null) {
        if (n.id === hovered) a = 1;
        else if (isActive(n.id)) a = fadeBase;
        else a = fadeBase * 0.12;
      } else {
        a = fadeBase;
      }
      if (a <= 0.02) continue;
      ctx.globalAlpha = a;
      ctx.fillText(n.label, n.x!, n.y! + n.radius + 13 / k);
    }

    ctx.restore();
  }

  // ===== 交互 =====

  private screenToWorld(sx: number, sy: number) {
    return {
      x: (sx - this.transform.x) / this.transform.k,
      y: (sy - this.transform.y) / this.transform.k,
    };
  }

  /** 聚焦节点：相机平滑把它移到画布正中心，并按邻域度数选缩放：
   * 邻居（相关节点）总度数越大 → 周边越密、摊得越开 → 相对缩得远些；孤立/稀疏节点 → 放大看。
   * 整体倍率偏大（用户两次反馈倍率太小/聚焦后点太小看不清），保证聚焦后节点与邻居清晰可辨。
   * 返回节点是否存在（不在扫描范围或被过滤掉时返回 false） */
  focusNode(id: string): boolean {
    const n = this.nodes.find((m) => m.id === id);
    if (!n) return false;
    let total = 0;
    const neigh = this.adj.get(id);
    if (neigh?.size) {
      const byId = new Map(this.nodes.map((m) => [m.id, m]));
      for (const nid of neigh) total += byId.get(nid)?.degree ?? 0;
    }
    const k = Math.max(2.4, Math.min(12.0, 12.8 / Math.pow(1 + total, 0.28)));
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    this.camAnim = {
      t0: performance.now(),
      dur: 650,
      from: { ...this.transform },
      to: { x: w / 2 - (n.x ?? 0) * k, y: h / 2 - (n.y ?? 0) * k, k },
    };
    this.hoverId = id;
    this.stickyId = id; // 高亮粘性保留：鼠标移动不清除，点下空白/节点才取消
    this.dirty = true;
    return true;
  }

  private hitTest(sx: number, sy: number): SimNode | null {
    const { x, y } = this.screenToWorld(sx, sy);
    let best: SimNode | null = null;
    let bestDist = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x! - x, n.y! - y);
      const hitR = Math.max(n.radius, 6 / this.transform.k) + 2;
      if (d < hitR && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  private pos(e: PointerEvent | WheelEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.camAnim = null; // 用户接管视角：打断聚焦动画
    const { x: mx, y: my } = this.pos(e);
    const oldK = this.transform.k;
    const newK = Math.max(0.02, Math.min(16, oldK * Math.exp(-e.deltaY * 0.0015)));
    this.transform.x = mx - ((mx - this.transform.x) * newK) / oldK;
    this.transform.y = my - ((my - this.transform.y) * newK) / oldK;
    this.transform.k = newK;
    this.dirty = true;
  };

  private onPointerDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.camAnim = null; // 用户接管视角：打断聚焦动画
    const { x, y } = this.pos(e);
    this.downPos = { x, y };
    const node = this.hitTest(x, y);
    this.downNode = node;
    if (node) {
      // 拖拽节点：钉住并低强度加热（0.12）：只让近邻温和跟随，避免全图被搅动（原生手感：拖拽时其余部分几乎不动）
      this.dragNode = node;
      node.fx = node.x;
      node.fy = node.y;
      this.sim?.alphaTarget(0.12).restart();
    } else {
      this.panStart = { x, y, tx: this.transform.x, ty: this.transform.y };
      this.canvas.style.cursor = 'grabbing';
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const { x, y } = this.pos(e);
    if (this.dragNode) {
      const w = this.screenToWorld(x, y);
      this.dragNode.fx = w.x;
      this.dragNode.fy = w.y;
      this.dirty = true;
      return;
    }
    if (this.panStart) {
      this.transform.x = this.panStart.tx + (x - this.panStart.x);
      this.transform.y = this.panStart.ty + (y - this.panStart.y);
      this.dirty = true;
      return;
    }
    const node = this.hitTest(x, y);
    const id = node?.id ?? null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.canvas.style.cursor = node ? 'pointer' : 'grab';
      this.dirty = true;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const { x, y } = this.pos(e);
    const moved = this.downPos ? Math.hypot(x - this.downPos.x, y - this.downPos.y) : 0;

    if (this.dragNode) {
      this.sim?.alphaTarget(0);
      this.dragNode.fx = null;
      this.dragNode.fy = null;
      if (moved < 4) {
        // 点击：不重热——满血 alpha(1) 会把被点节点和近邻推得抖一下（用户反馈）；
        // 只把按住期间积攒的低热量（0.12 目标）快速冷却，节点原地不动；然后打开节点
        this.sim?.alpha(Math.min(this.sim?.alpha() ?? 0, 0.02));
        if (this.downNode) this.cb.onOpenNode(this.downNode);
      } else {
        // 真正的拖拽：节点换了位置，松手满血重启让布局重新平复（首次实现 OpenOrd 时的快照）
        this.sim?.alpha(1).restart();
      }
      this.dragNode = null;
    } else if (this.panStart && moved < 4 && this.downNode) {
      this.cb.onOpenNode(this.downNode);
    }

    // 点下空白或某个节点：取消聚焦后的粘性高亮（鼠标移动不清除，见 stickyId）
    if (this.stickyId) {
      this.stickyId = null;
      this.dirty = true;
    }

    this.panStart = null;
    this.downPos = null;
    this.downNode = null;
    this.canvas.style.cursor = this.hoverId ? 'pointer' : 'grab';
    this.dirty = true;
  };

  private onPointerLeave = () => {
    if (this.hoverId !== null) {
      this.hoverId = null;
      this.dirty = true;
    }
  };
}
