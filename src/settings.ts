import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from './graph/config';
import { SyncServer, SYNC_PORT_DEFAULT, type SyncSettings } from './sync/SyncServer';
import type MemosPlugin from './main';

/** 默认扫描文件夹：插件启动时自动创建（已存在则跳过），默认只扫描它 */
export const DEFAULT_SCAN_FOLDER = 'Memmos graph';

/** 路径归一化：去首尾空白与斜杠；返回空串 = 扫描整个仓库 */
export function normalizeFolder(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '');
}

export interface MemosSettings {
  apiKey: string;
  model: string;
  /** 图谱扫描文件夹（空串 = 扫描整个仓库） */
  scanFolder: string;
  /** 图谱视图设置（过滤器/分组/显示/力学） */
  graph: GraphSettings;
  /** 设备配对与同步（Android Memmos ↔ 本插件） */
  sync: SyncSettings;
}

export const DEFAULT_SETTINGS: MemosSettings = {
  apiKey: '',
  model: 'qwen-plus',
  scanFolder: DEFAULT_SCAN_FOLDER,
  graph: { ...DEFAULT_GRAPH_SETTINGS },
  sync: {
    syncEnabled: false,
    syncPort: SYNC_PORT_DEFAULT,
    syncToken: '',
    pairCode: '',
    syncFolder: 'Memmos graph',
  },
};

/**
 * 设置页：Qwen API Key 与模型
 */
export class MemosSettingTab extends PluginSettingTab {
  plugin: MemosPlugin;
  /** 扫描文件夹输入防抖：避免每敲一个字就重建图谱 */
  private folderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, plugin: MemosPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Qwen API Key')
      .setDesc('用于 AI 对话与图谱归纳（存于插件本地配置）')
      .addText((text) =>
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('模型')
      .setDesc('默认 qwen-plus')
      .addText((text) =>
        text
          .setPlaceholder('qwen-plus')
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim() || 'qwen-plus';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('图谱扫描文件夹')
      .setDesc('只扫描该文件夹下的笔记构图；留空 = 扫描整个仓库')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SCAN_FOLDER)
          .setValue(this.plugin.settings.scanFolder)
          .onChange(async (value) => {
            const folder = normalizeFolder(value);
            this.plugin.settings.scanFolder = folder;
            await this.plugin.saveSettings();
            // 防抖通知图谱视图刷新（重建图数据）
            if (this.folderTimer) clearTimeout(this.folderTimer);
            this.folderTimer = setTimeout(() => {
              this.plugin.notifyScanFolderChange(folder);
            }, 500);
          }),
      );

    new Setting(containerEl)
      .setName('扫描整个仓库')
      .setDesc(`一键切换：开启 = 扫描全部文件夹；关闭 = 回到默认文件夹 ${DEFAULT_SCAN_FOLDER}`)
        .addToggle((toggle) =>
        toggle
            .setValue(this.plugin.settings.scanFolder === '')
            .onChange(async (value) => {
              if (value) {
                this.plugin.settings.scanFolder = '';
              } else {
                this.plugin.settings.scanFolder = DEFAULT_SCAN_FOLDER;
                await this.plugin.ensureScanFolder(DEFAULT_SCAN_FOLDER);
              }
              await this.plugin.saveSettings();
              this.plugin.notifyScanFolderChange(this.plugin.settings.scanFolder);
              this.display(); // 同步刷新上方输入框的显示值
            }),
    );

    // ═══ 设备配对与同步（Android Memmos ↔ 本插件） ═══
    new Setting(containerEl).setName('设备同步').setHeading();

    new Setting(containerEl)
      .setName('启用同步服务')
      .setDesc('在同一局域网内，手机 Memmos 可与本库配对并双向同步剪藏/笔记')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.sync.syncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.sync.syncEnabled = value;
            await this.plugin.saveSettings();
            await this.plugin.applySyncService();
            this.display();
          }),
      );

    if (this.plugin.settings.sync.syncEnabled) {
      const ips = SyncServer.localIPs();
      new Setting(containerEl)
        .setName('本机地址')
        .setDesc(
          `手机端 Memmos → 设置 → 设备配对，输入以下地址与配对码：\n` +
          (ips.length ? ips.map((ip) => `${ip}:${this.plugin.settings.sync.syncPort}`).join('\n') : '（未检测到局域网 IP）'),
        );

      new Setting(containerEl)
        .setName('配对码')
        .setDesc(`手机端输入此 6 位码完成配对（配对后交换长效令牌）`)
        .addText((text) =>
          text
            .setValue(this.plugin.sync.ensurePairCode())
            .setDisabled(true),
        )
        .addButton((btn) =>
          btn.setButtonText('重新生成').onClick(async () => {
            this.plugin.settings.sync.pairCode = '';
            await this.plugin.saveSettings();
            this.plugin.sync.ensurePairCode();
            new Notice('已生成新配对码');
            this.display();
          }),
        );

      new Setting(containerEl)
        .setName('端口')
        .setDesc(`默认 ${SYNC_PORT_DEFAULT}，修改后需关闭再开启同步服务`)
        .addText((text) =>
          text
            .setValue(String(this.plugin.settings.sync.syncPort))
            .onChange(async (v) => {
              const p = parseInt(v, 10);
              if (p > 0 && p < 65536) {
                this.plugin.settings.sync.syncPort = p;
                await this.plugin.saveSettings();
              }
            }),
        );

      new Setting(containerEl)
        .setName('同步文件夹')
        .setDesc('手机端只同步此文件夹内的 md（与图谱扫描范围相互独立）')
        .addText((text) =>
          text
            .setValue(this.plugin.settings.sync.syncFolder)
            .setPlaceholder('Memmos graph')
            .onChange(async (v) => {
              this.plugin.settings.sync.syncFolder = normalizeFolder(v) || 'Memmos graph';
              await this.plugin.saveSettings();
            }),
        );
    }
  }
}
