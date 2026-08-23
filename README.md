# Memmos Graph

**Memmos Graph** 是一个 Obsidian 桌面端插件：为笔记库提供 Canvas 自绘的知识图谱视图，带物理布局动画、过滤器、分组着色与文件定位能力。

> 项目背景、架构与开发细节请见 [HANDOVER.md](./HANDOVER.md)。

## 功能一览

- **Canvas 知识图谱**：d3-force 深度定制物理引擎，OpenOrd 五阶段布局 + 平滑回火动画
- **过滤器与分组**：搜索、标签、附件、仅已有文件；自定义分组着色
- **在图谱中定位**：笔记标题栏准星按钮 / 文件右键 / 编辑器右键 / 命令面板，丝滑聚焦居中，缩放按邻居度数自适应
- **扫描范围**：默认扫描 `Memmos graph` 文件夹（首次启用自动创建），可一键切换全库
- **编辑防抖刷新**：编辑中的笔记不会反复触发图谱重建，关闭该笔记后才刷新一次

## 手动安装

1. 克隆本仓库，将 `main.js`、`manifest.json`、`styles.css` 三个文件拷贝到
   `<你的Vault>/.obsidian/plugins/memos-graph/` 目录
2. 重启 Obsidian，在 设置 → 第三方插件 中启用 **Memmos Graph**
3. 点击左侧缎带图标（或命令面板「打开 Memmos 图谱」）即可打开图谱视图

## 从源码开发

```bash
npm install
npm run dev          # esbuild 监听构建
npm run typecheck    # 类型检查
npm run build        # 生产构建（产物在根目录）
npm run deploy       # 构建并部署到本机 Vault（路径见 scripts/deploy.mjs）
```

## 版本

- `0.0.1` — 首个可用版本：图谱视图、布局动画、过滤器、定位、扫描文件夹、刷新挂起

## 许可与作者

作者：[Tylor110077](https://github.com/Tylor110077)
