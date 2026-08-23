import { Plugin, TFile, MarkdownView, setIcon, type WorkspaceLeaf } from 'obsidian';
import { GRAPH_VIEW_TYPE, MemosGraphView } from './view';
import {
  MemosSettingTab,
  DEFAULT_SETTINGS,
  DEFAULT_SCAN_FOLDER,
  normalizeFolder,
  type MemosSettings,
} from './settings';
import { DEFAULT_GRAPH_SETTINGS } from './graph/config';

/**
 * Memmos Graph 插件入口
 * - 左侧边栏图标 + 命令面板打开图谱视图
 * - 设置页管理 Qwen API Key（后续 AI 功能使用）
 */
export default class MemosPlugin extends Plugin {
  settings: MemosSettings = { ...DEFAULT_SETTINGS };
  /** 扫描文件夹变更订阅者（图谱视图挂载时订阅，卸载时退订） */
  private scanFolderListeners = new Set<(folder: string) => void>();
  /** 图谱聚焦请求订阅者（图谱视图挂载时订阅） */
  private focusListeners = new Set<(path: string) => void>();

  async onload() {
    await this.loadSettings();

    // 默认扫描文件夹：首次使用插件时自动创建（已存在则跳过）
    await this.ensureScanFolder(DEFAULT_SCAN_FOLDER);

    // 注册图谱视图
    this.registerView(GRAPH_VIEW_TYPE, (leaf) => new MemosGraphView(leaf, this));

    // 左侧边栏入口
    this.addRibbonIcon('network', '打开 Memmos 图谱', () => {
      this.activateView();
    });

    // 命令面板入口（可绑定快捷键）
    this.addCommand({
      id: 'open-memos-graph',
      name: '打开 Memmos 图谱',
      callback: () => this.activateView(),
    });

    // 设置页
    this.addSettingTab(new MemosSettingTab(this.app, this));

    // 在图谱中定位：文件右键菜单 + 编辑器右键菜单 + 命令面板（可绑快捷键）
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item) =>
            item
              .setTitle('在 Memmos 图谱中定位')
              .setIcon('crosshair')
              .onClick(() => this.requestFocus(file.path)),
          );
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu) => {
        const file = this.app.workspace.getActiveFile();
        if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item) =>
            item
              .setTitle('在 Memmos 图谱中定位')
              .setIcon('crosshair')
              .onClick(() => this.requestFocus(file.path)),
          );
        }
      }),
    );
    this.addCommand({
      id: 'focus-active-file',
      name: '在 Memmos 图谱中定位当前文件',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) this.requestFocus(file.path);
      },
    });

    // 笔记页标题附近的明确按钮：给所有打开的 md 视图头部注入（含非激活视图，不因失焦而消失）
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.injectFocusButtons()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.injectFocusButtons()));
    // 插件启动时已有的笔记页也需注入（延迟等头部渲染完成）
    window.setTimeout(() => this.injectFocusButtons(), 300);
  }
  
  onunload() {
    // 视图由 Obsidian 工作区管理，无需手动清理；但注入的按钮要移除，避免禁用插件后残留
    document.querySelectorAll('.memmos-focus-btn').forEach((el) => el.remove());
  }

  /** 打开（或聚焦已打开的）图谱视图 */
  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(GRAPH_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: GRAPH_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<MemosSettings> | null;
    // 配置版本不匹配时重置图谱默认值（避免旧默认值覆盖新调优）
    const graph =
      loaded?.graph?.version === DEFAULT_GRAPH_SETTINGS.version
        ? { ...DEFAULT_GRAPH_SETTINGS, ...loaded.graph }
        : { ...DEFAULT_GRAPH_SETTINGS };
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      graph,
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** 确保扫描文件夹存在（已存在则跳过，创建失败静默忽略不阻塞插件） */
  async ensureScanFolder(path: string) {
    const p = normalizeFolder(path);
    if (!p || this.app.vault.getAbstractFileByPath(p)) return;
    try {
      await this.app.vault.createFolder(p);
    } catch {
      // 并发创建或路径非法：不阻塞插件加载
    }
  }

  /** 订阅扫描文件夹变更，返回退订函数 */
  onScanFolderChange(cb: (folder: string) => void): () => void {
    this.scanFolderListeners.add(cb);
    return () => this.scanFolderListeners.delete(cb);
  }

  /** 通知所有图谱视图刷新（设置页改动扫描范围后调用） */
  notifyScanFolderChange(folder: string) {
    for (const cb of this.scanFolderListeners) cb(folder);
  }

  /** 在图谱中定位文件（两段式，用户要求）：图谱未打开 → 第一次点击只打开图谱不定位；
   * 已打开 → 点击才把节点丝滑聚焦到正中心 */
  requestFocus(path: string) {
    const graphOpen = this.app.workspace.getLeavesOfType(GRAPH_VIEW_TYPE).length > 0;
    if (!graphOpen) {
      void this.activateView();
      return; // 第一次点击只打开，不定位；再点一次才定位
    }
    for (const cb of this.focusListeners) cb(path);
  }

  /** 订阅聚焦请求，返回退订函数 */
  onFocusRequest(cb: (path: string) => void): () => void {
    this.focusListeners.add(cb);
    return () => this.focusListeners.delete(cb);
  }

  /** 给所有打开的 md 视图头部（标题附近）注入“在 Memmos 图谱中定位”按钮：
   * 非激活（未 focus）的视图也保留按钮；同一视图只注入一次，点击时动态取该视图当前文件 */
  private injectFocusButtons(retry = 0) {
    let needRetry = false;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file || view.file.extension !== 'md') continue;
      if (view.containerEl.querySelector('.memmos-focus-btn')) continue; // 已注入，不重复添加
      // 优先视图操作区；不同 Obsidian 版本 DOM 可能没有该容器 → 回退挂到头部根节点（仍在标题旁）
      const container =
        view.containerEl.querySelector('.view-header .view-header-action-container') ??
        view.containerEl.querySelector('.view-header');
      if (!container) {
        // 叶子刚打开时头部可能尚未渲染：稍后整体重试（限次防无限循环）
        needRetry = true;
        continue;
      }
      const btn = document.createElement('div');
      btn.className = 'clickable-icon memmos-focus-btn';
      btn.setAttribute('aria-label', '在 Memmos 图谱中定位');
      btn.setAttribute('title', '在 Memmos 图谱中定位');
      setIcon(btn, 'crosshair');
      btn.addEventListener('click', () => {
        // 叶子可能已切到别的文件：点击时取当前文件，不用注入时的旧路径
        const f = view.file;
        if (f) this.requestFocus(f.path);
      });
      container.appendChild(btn);
    }
    if (needRetry && retry < 10) window.setTimeout(() => this.injectFocusButtons(retry + 1), 300);
  }
}
