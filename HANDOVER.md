# Memmos Graph 交接文档

> 本仓库是 **Memmos Graph** Obsidian 插件的完整源码与构建产物。本文档面向后续接手维护者，覆盖架构、开发流程、关键设计决策与已知约束。
> 交接日期：2026-08-24

---

## 1. 项目概述

Memmos Graph 是一个 Obsidian 桌面端插件，为 Vault 提供 **Canvas 自绘知识图谱**：

- 基于 **d3-force 深度定制的物理引擎**（非 DOM/SVG，纯 Canvas 渲染，支持数百节点流畅交互）
- **OpenOrd 五阶段布局** + 末段自由伸缩，配平滑回火，布局过程有"仪式感"的连续动画
- 过滤器（搜索/标签/附件/仅已有文件）、分组着色、显示与力学参数实时调节
- **在图谱中定位文件**：笔记标题栏按钮 / 文件右键 / 编辑器右键 / 命令面板四入口
- 扫描范围控制：默认只扫 `Memmos graph` 文件夹，可一键切换全库
- 编辑中的笔记不会触发图谱反复刷新，关闭该笔记后才重建一次

插件 id 为 `memos-graph`（与 `.obsidian/plugins/memos-graph` 目录名绑定，**不可更改**），显示名为 **Memmos Graph**。

## 2. 目录结构

```
├── manifest.json          # 插件清单（id 不可改；isDesktopOnly: true）
├── versions.json          # 版本 → 最低 Obsidian 版本映射（社区插件规范）
├── package.json           # 构建脚本与依赖
├── esbuild.config.mjs     # esbuild 构建（产物：根目录 main.js + main.css）
├── tsconfig.json
├── styles.css             # 手写样式（与 main.css 合并部署）
├── main.js / main.css     # 构建产物（随仓库提交，可直接安装）
├── scripts/
│   └── deploy.mjs         # 部署到本机 Vault 插件目录
└── src/
    ├── main.ts            # 插件入口：命令/菜单/头部按钮注入/聚焦请求广播/扫描文件夹
    ├── settings.ts        # 设置页（apiKey/model/扫描文件夹/图谱参数）
    ├── view.tsx           # 图谱视图（ItemView + React 挂载）
    ├── graph/
    │   ├── GraphEngine.ts # 核心：Canvas 渲染 + d3-force 物理 + 交互 + 相机动画（约 700 行）
    │   ├── buildGraph.ts  # 从 Vault 构建图数据（双链解析/幽灵节点/文件夹过滤）
    │   ├── config.ts      # 图谱设置类型与默认值
    │   └── filter.ts      # 搜索/显示过滤器
    └── ui/
        ├── GraphApp.tsx            # React 根组件：引擎生命周期/数据重建/事件订阅
        └── GraphSettingsPanel.tsx  # 图谱齿轮设置面板
```

## 3. 技术栈与依赖

| 项 | 说明 |
|---|---|
| 语言 | TypeScript 5.5 严格模式 |
| 渲染 | 原生 Canvas 2D（devicePixelRatio 适配） |
| 物理 | d3-force 3（charge/link/collide/center + 自定义围合力） |
| UI | React 19（仅设置面板与视图挂载，图谱本体不走 React 渲染） |
| 构建 | esbuild（`npm run build`），产物单行压缩 |
| 类型 | `obsidian` 官方 d.ts（注意：当前版本类型里**没有** `getActiveLeaf()`，用 `workspace.activeLeaf`） |

## 4. 开发、构建与部署

```bash
npm install
npm run typecheck      # tsc --noEmit，必须零错误后再构建
npm run build          # esbuild 生产构建 → 根目录 main.js / main.css
npm run deploy         # 构建 + 部署到 /Users/tylor/Note/OBISIDIAN/.obsidian/plugins/memos-graph
```

部署脚本 `scripts/deploy.mjs`：

- 拷贝 `main.js`、`manifest.json`；把 `main.css + styles.css` 合并为 `styles.css` 写入插件目录
- 可用 `node scripts/deploy.mjs <vault路径>` 或环境变量 `OBSIDIAN_VAULT` 指向其它 Vault
- 部署后需在 Obsidian 中**禁用再启用**插件（或重启）才能生效

### 验证产物的正确姿势（重要）

- `main.js` 是**单行文件**：`grep -c` 只会返回行数 1，计数出现次数要用 `grep -oE "xxx" main.js | wc -l`
- esbuild 会**重命名常量/方法**（如 `TICKS_PER_FRAME` → `iy`），验证行为要抓赋值而非名字
- esbuild 会把**中文转成 `\uXXXX` 转义**，直接 `grep` 中文会扑空，用 `node -e` 读文件 `includes()` 判断

## 5. 核心设计决策（改代码前必读）

### 5.1 布局物理（GraphEngine）

- OpenOrd 五阶段用**连续关键帧插值**实现（非离散跳变）：斥力乘子 `REPEL_KEYS`、剪边阈值 `CUT_KEYS`，`smoothstep` 缓动
- 第 560 tick 进入"自由伸缩"潮汐回火：`alphaTarget(0.3)` 涨潮 → 100 tick 后 `alphaTarget(0)` 退潮
- 收敛质量取决于**物理总步数**，不要为提速压缩步数预算（曾因此翻车回退）
- 点击（位移 < 4）不重热模拟，只冷却；真拖拽才 `alpha(1).restart()`——否则会抖

### 5.2 定位文件（两段式 + 粘性高亮）

- 图谱未打开：第一次点击按钮**只打开图谱**；已打开才广播聚焦（`requestFocus`）
- `focusNode`：smoothstep 相机动画 650ms 居中，缩放按邻居总度数 `k = clamp(12.8/(1+total)^0.28, 2.4, 12.0)`
- 聚焦后**粘性高亮**（`stickyId`）：鼠标移动不清除，点下空白/节点才取消

### 5.3 头部定位按钮注入

- 遍历 `getLeavesOfType('markdown')` 给**所有**打开的 md 视图注入 `.memmos-focus-btn`（失焦不消失）
- 容器选择 `.view-header .view-header-action-container`，回退 `.view-header`（兼容不同 Obsidian 版本 DOM）
- 按钮点击时动态读 `view.file`（叶子复用会换文件）；CSS 锁 26×26 对齐原生图标

### 5.4 扫描文件夹

- 设置 `scanFolder`（空串 = 全库），默认 `Memmos graph`，插件启动自动创建该文件夹
- 过滤用 `路径前缀 + '/'` 归一化（防 `Memmos graphX` 误匹配）；幽灵节点需 `mdSet.has(src)` 防范围外泄漏
- 设置变更经监听器广播 → GraphApp 状态驱动重建

### 5.5 刷新挂起策略

- `vault.on('modify')` 精确定位被编辑文件：仍处于打开状态 → 挂起，不刷新；关闭该笔记（`layout-change` 检测）才重建一次
- 删除/重命名无法挂起，直接刷新；外部改动未打开文件不受影响

## 6. 已知约束与坑

1. **manifest id 不可改**：改 id 等于新插件，用户配置和安装目录全断
2. **仅桌面端**（`isDesktopOnly: true`）：依赖 Canvas + 指针事件，未适配移动端
3. `workspace.activeLeaf` 是废弃属性但类型可用；`getActiveLeaf()` 在当前类型定义里不存在
4. React 19 + Obsidian 共存：视图卸载走 `onClose` → `root.unmount()`，引擎销毁务必在 React 清理之外兜底
5. 图谱只扫双链（`[[link]]`），不扫 Markdown 链接（产品决策：对齐 Obsidian 原生图谱）

## 7. 待办与可能方向

- [ ] 移动端适配（若需要）
- [ ] 提交 Obsidian 社区插件市场（需 `release` 分支 + tag，`manifest.json`/`main.js`/`styles.css` 已在仓库根目录就位）
- [ ] 大库性能：千节点以上可考虑 WebGL 渲染
- [ ] AI 对话能力（apiKey/model 设置已预留，当前版本未启用对话面板）

## 8. 联系人

- 作者：Tylor（GitHub: [Tylor110077](https://github.com/Tylor110077)）
- 仓库：https://github.com/Tylor110077/Obsidian_Memmos
