import { useCallback, useEffect, useRef, useState } from 'react';
import { Notice, TFile, type EventRef } from 'obsidian';
import { GraphEngine } from '../graph/GraphEngine';
import { buildGraph } from '../graph/buildGraph';
import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from '../graph/config';
import type { GNode } from '../graph/buildGraph';
import { GraphSettingsPanel } from './GraphSettingsPanel';
import type MemosPlugin from '../main';

/** 点击节点：文件/附件 → 打开；幽灵节点 → 创建后打开（同 Obsidian） */
async function openNode(plugin: MemosPlugin, n: GNode) {
  const app = plugin.app;
  if (n.kind === 'file' || n.kind === 'attachment') {
    const f = n.path ? app.vault.getAbstractFileByPath(n.path) : null;
    if (f instanceof TFile) app.workspace.getLeaf(false).openFile(f);
    return;
  }
  if (n.kind === 'ghost') {
    const name = n.label.replace(/[\\/:*?"<>|#^[\]]/g, '').trim();
    if (!name) return;
    let f = app.metadataCache.getFirstLinkpathDest(name, '/');
    if (!(f instanceof TFile)) {
      try {
        f = await app.vault.create(`${name}.md`, '');
      } catch {
        // 创建失败（撞名/非法名等）：回查已有文件兜底，不让异常悬空
        f = app.metadataCache.getFirstLinkpathDest(name, '/');
      }
    }
    if (!(f instanceof TFile)) {
      new Notice(`无法创建「${name}.md」`);
      return;
    }
    app.workspace.getLeaf(false).openFile(f);
  }
}

/**
 * Memos 图谱视图（1:1 复刻 Obsidian 原生图谱）
 * canvas 渲染 + d3-force 物理 + 过滤器/分组/显示/力学设置
 */
export function GraphApp({ plugin }: { plugin: MemosPlugin }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  /** 早到的聚焦请求（图数据正在重建的短暂窗口）：记下路径，建完后补放 */
  const pendingFocus = useRef<string | null>(null);
  /** 图数据是否已就绪（首轮构建完成）：未就绪时聚焦请求暂存，就绪后找不到节点则提示 */
  const dataReady = useRef(false);
  /** 设置持久化防抖计时器 */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settings, setSettings] = useState<GraphSettings>(() => ({
    ...DEFAULT_GRAPH_SETTINGS,
    ...plugin.settings.graph,
  }));
  const [panelOpen, setPanelOpen] = useState(false);
  // 扫描文件夹（空串 = 全库）：初始读插件设置，设置页改动时经订阅推送更新 → 重建图数据刷新图谱
  const [scanFolder, setScanFolder] = useState(plugin.settings.scanFolder);

  // 订阅设置页的扫描文件夹变更（卸载时退订）
  useEffect(() => plugin.onScanFolderChange((folder) => setScanFolder(folder)), [plugin]);

  // 引擎初始化（仅一次）
  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new GraphEngine(canvasRef.current, settings, {
      onOpenNode: (n) => void openNode(plugin, n),
    });
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin]);

  // 聚焦请求（文件右键菜单/命令面板/头部按钮）：两段式下只在图谱已打开时到达，
  // 仅在数据重建的短暂窗口内暂存；找不到节点（扫描范围外/被过滤）则提示
  useEffect(
    () =>
      plugin.onFocusRequest((path) => {
        if (!dataReady.current) {
          pendingFocus.current = path;
        } else if (!engineRef.current?.focusNode(path)) {
          new Notice('该文件不在当前图谱中（可能被扫描范围或过滤器排除）');
        }
      }),
    [plugin],
  );

  // 结构变化（过滤器/扫描文件夹）→ 重建图数据（异步：需读取文件内容解析 Markdown 链接）
  useEffect(() => {
    let cancelled = false;
    void buildGraph(plugin.app, {
      search: settings.search,
      showTags: settings.showTags,
      showAttachments: settings.showAttachments,
      existingOnly: settings.existingOnly,
      folder: scanFolder,
    }).then((data) => {
      if (cancelled) return;
      engineRef.current?.setData(data.nodes, data.links);
      engineRef.current?.setGroups(settings.groups);
      dataReady.current = true;
      // 图数据就绪：补放早到的聚焦请求（刚打开视图就定位的场景）
      if (pendingFocus.current) {
        engineRef.current?.focusNode(pendingFocus.current);
        pendingFocus.current = null;
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.search, settings.showTags, settings.showAttachments, settings.existingOnly, settings.groups, scanFolder]);

  // 显示/力学设置 → 引擎实时应用（滑块即时生效）；持久化防抖 500ms：搜索框逐字输入不该每键写一次盘
  useEffect(() => {
    engineRef.current?.setConfig(settings);
    plugin.settings.graph = settings;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void plugin.saveSettings();
    }, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // 卸载时补写未落盘的设置：视图关闭不丢最后一次改动
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void plugin.saveSettings();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // vault 元数据就绪后自动重建（防抖）；
  // 正在编辑（仍打开着）的 md 改动不刷新：挂起变更，等该文件关闭后才重建一次（用户要求）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 挂起的变更：文件仍处于打开状态时不刷新图谱（编辑中途的保存不该反复重排图谱）
    const deferred = new Set<string>();
    let dirty = false; // vault 是否有未挂起的新改动（删除/重命名无法挂起，直接刷新）

    const isOpenMd = (path: string) =>
      plugin.app.workspace
        .getLeavesOfType('markdown')
        .some((leaf) => {
          const f = (leaf.view as { file?: TFile | null }).file;
          return f instanceof TFile && f.path === path;
        });

    const scheduleRebuild = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void buildGraph(plugin.app, {
          search: settings.search,
          showTags: settings.showTags,
          showAttachments: settings.showAttachments,
          existingOnly: settings.existingOnly,
          folder: scanFolder,
        }).then((data) => {
          engineRef.current?.setData(data.nodes, data.links);
          engineRef.current?.setGroups(settings.groups);
        });
      }, 800);
    };

    // 挂起的文件全部关闭（且无其他新改动）→ 才真正刷新；否则继续等下一次关闭事件检查（限次防无限轮询）
    const flushIfClosed = (retry = 0) => {
      const openDeferred = [...deferred].filter(isOpenMd);
      if (openDeferred.length || dirty) {
        if (retry < 40) setTimeout(() => flushIfClosed(retry + 1), 3000);
        return;
      }
      deferred.clear();
      scheduleRebuild();
    };

    // 内容修改：仅当该文件正处于打开状态（被编辑中）才挂起；否则正常防抖刷新。
    // 用 modify 事件精确定位被编辑的文件，避免“开着 A 时 B 被外部改动”被误挂起。
    const evModify: EventRef = plugin.app.vault.on('modify', (file) => {
      if (file instanceof TFile && isOpenMd(file.path)) {
        deferred.add(file.path);
      } else {
        dirty = true;
        scheduleRebuild();
      }
    });
    // 删除/重命名无法挂起（节点结构即时变化），直接刷新并清掉相关挂起项（路径已失效）
    const evDelete: EventRef = plugin.app.vault.on('delete', (file) => {
      if (file instanceof TFile) deferred.delete(file.path);
      dirty = true;
      scheduleRebuild();
    });
    const evRename: EventRef = plugin.app.vault.on('rename', () => {
      deferred.clear();
      dirty = true;
      scheduleRebuild();
    });

    // 解析完成：有挂起的编辑中文件 → 不刷新等关闭；无挂起 → 正常防抖刷新（如初次建索引）
    const evResolved: EventRef = plugin.app.metadataCache.on('resolved', () => {
      if (deferred.size) {
        flushIfClosed();
      } else {
        dirty = true;
        scheduleRebuild();
      }
    });
    // 叶子关闭/切换：检查挂起的文件是否已关闭 → 是则立刻刷新，不等下一轮轮询；并消费脏标记避免重复重建
    const evLayout: EventRef = plugin.app.workspace.on('layout-change', () => {
      if (!dirty && !deferred.size) return;
      dirty = false;
      flushIfClosed();
    });

    return () => {
      plugin.app.metadataCache.offref(evResolved);
      plugin.app.vault.offref(evModify);
      plugin.app.vault.offref(evDelete);
      plugin.app.vault.offref(evRename);
      plugin.app.workspace.offref(evLayout);
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.search, settings.showTags, settings.showAttachments, settings.existingOnly, settings.groups, scanFolder]);

  const handleChange = useCallback((patch: Partial<GraphSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
  }, []);

  return (
    <div className="memos-graph-root">
      <canvas ref={canvasRef} className="memos-graph-canvas" />
      {!panelOpen && (
        <button className="mg-gear" onClick={() => setPanelOpen(true)} aria-label="图谱设置">
          {/* 齿轮图标 */}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      )}
      {panelOpen && (
        <GraphSettingsPanel settings={settings} onChange={handleChange} onClose={() => setPanelOpen(false)} />
      )}
    </div>
  );
}
