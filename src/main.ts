import { Plugin, TFile, MarkdownView, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
import { GRAPH_VIEW_TYPE, MemosGraphView } from './view';
import {
  MemosSettingTab,
  DEFAULT_SETTINGS,
  DEFAULT_SCAN_FOLDER,
  normalizeFolder,
  type MemosSettings,
} from './settings';
import { DEFAULT_GRAPH_SETTINGS } from './graph/config';
import { SyncServer } from './sync/SyncServer';
import { wrapImageGroups } from './gallery';

/**
 * Memmos Graph 插件入口
 * - 左侧边栏图标 + 命令面板打开图谱视图
 * - 设置页管理 Qwen API Key（后续 AI 功能使用）
 * - 设备同步：局域网 HTTP 服务，与 Android Memmos 配对后双向同步（src/sync/）
 * - 图片画廊：同步文件夹内连续多图 → 点击上一张/下一张（src/gallery/）
 */
export default class MemosPlugin extends Plugin {
  settings: MemosSettings = { ...DEFAULT_SETTINGS };
  /** 扫描文件夹变更订阅者（图谱视图挂载时订阅，卸载时退订） */
  private scanFolderListeners = new Set<(folder: string) => void>();
  /** 图谱聚焦请求订阅者（图谱视图挂载时订阅） */
  private focusListeners = new Set<(path: string) => void>();
  /** 卸载标记：启动时的延迟回调（按钮注入及其重试链）在插件禁用后不得再触碰 DOM */
  private unloaded = false;
  /** 设备同步服务（Android Memmos ↔ 本插件） */
  sync!: SyncServer;

  async onload() {
    await this.loadSettings();

    // 旧配置无 sync 段（或字段缺失）时补默认值，避免 undefined 崩
    if (!this.settings.sync) {
      this.settings.sync = { ...DEFAULT_SETTINGS.sync };
    }

    // 默认扫描文件夹：仅当当前设置指向默认值时自动创建（首次使用场景，已存在则跳过）；
    // 已切到全库（空串）或自定义文件夹时不代建，尊重用户对库结构的调整
    if (this.settings.scanFolder === DEFAULT_SCAN_FOLDER) {
      await this.ensureScanFolder(DEFAULT_SCAN_FOLDER);
    }

    this.sync = new SyncServer(this);
    // 同步服务开关与设置一致；失败（如端口占用）提示不阻塞插件
    void this.applySyncService();

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

    // 设备同步命令：切换服务 + 显示配对信息
    this.addCommand({
      id: 'toggle-sync',
      name: '开启/关闭设备同步服务',
      callback: async () => {
        this.settings.sync.syncEnabled = !this.settings.sync.syncEnabled;
        await this.saveSettings();
        await this.applySyncService();
        if (this.settings.sync.syncEnabled) {
          const ips = SyncServer.localIPs();
          new Notice(
            `同步已开启 ${ips[0] ?? '本机'}:${this.sync.port}\n配对码 ${this.sync.ensurePairCode()}`,
            8000,
          );
        } else {
          new Notice('同步已关闭');
        }
      },
    });

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

    // 图片画廊（用户要求：同步文件夹内连续多图 → 点击左右两侧/箭头换上一张下一张）
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!this.isInsideSyncFolder(ctx.sourcePath)) return;
      wrapImageGroups(el);
    });
  }
  
  onunload() {
    this.unloaded = true;
    // 视图由 Obsidian 工作区管理，无需手动清理；但注入的按钮要移除，避免禁用插件后残留
    document.querySelectorAll('.memmos-focus-btn').forEach((el) => el.remove());
    // 同步服务随插件停用
    this.sync?.stop();
  }

  /** 按设置启停同步服务（端口占用等失败给 Notice，不抛出） */
  async applySyncService() {
    if (this.settings.sync.syncEnabled) {
      try {
        await this.sync.start();
      } catch (e) {
        new Notice(`同步服务启动失败：${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      this.sync.stop();
    }
  }

  /** 路径是否在同步文件夹内（图片画廊只在此文件夹生效，用户要求） */
  private isInsideSyncFolder(path: string): boolean {
    const root = normalizeFolder(this.settings.sync?.syncFolder ?? '');
    // 同步文件夹恒为具体路径（设置页归一化回退 'Memmos graph'），空串 = 全库则不套用
    return root !== '' && (path === root || path.startsWith(root + '/'));
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
    if (this.unloaded) return; // 插件已禁用：启动延迟注入与重试链全部作废
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
