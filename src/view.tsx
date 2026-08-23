import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import { GraphApp } from './ui/GraphApp';
import type MemosPlugin from './main';

export const GRAPH_VIEW_TYPE = 'memos-graph-view';

/**
 * 图谱视图：把一个 React 容器挂进 Obsidian 的 ItemView
 */
export class MemosGraphView extends ItemView {
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: MemosPlugin) {
    super(leaf);
  }

  getViewType() {
    return GRAPH_VIEW_TYPE;
  }

  getDisplayText() {
    return 'Memos 图谱';
  }

  getIcon() {
    return 'network';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('memos-graph-container');
    this.root = createRoot(container);
    this.root.render(<GraphApp plugin={this.plugin} />);
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
