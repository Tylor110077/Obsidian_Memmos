import { App, PluginSettingTab, Setting } from 'obsidian';
import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from './graph/config';
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
}

export const DEFAULT_SETTINGS: MemosSettings = {
  apiKey: '',
  model: 'qwen-plus',
  scanFolder: DEFAULT_SCAN_FOLDER,
  graph: { ...DEFAULT_GRAPH_SETTINGS },
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
  }
}
