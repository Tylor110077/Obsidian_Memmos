import type { App } from 'obsidian';
import { parseTokens, tokensMatch } from './filter';

export type NodeKind = 'file' | 'tag' | 'attachment' | 'ghost';

export interface GNode {
  id: string;
  kind: NodeKind;
  label: string;
  path?: string;
  /** 文件节点携带自身标签，用于 tag: 过滤与分组 */
  tags?: string[];
}

export interface GLink {
  source: string;
  target: string;
}

export interface GraphQuery {
  search: string;
  showTags: boolean;
  showAttachments: boolean;
  existingOnly: boolean;
  /** 扫描文件夹（空/未传 = 扫描整个仓库） */
  folder?: string;
}

/**
 * 扫描 vault 构建图谱数据（与原生图谱对齐：只认 [[双链]]，不扫标准 Markdown 链接）：
 * - md 文件 → 文件节点；已解析双链 → 边
 * - 标准 Markdown 链接 [文本](路径)：原生图谱不画这类链接，为对齐原生不扫描（避免造出原生不存在的巨型枢纽）
 * - showTags: 标签节点 + 文件→标签 边
 * - showAttachments: 被引用的非 md 附件节点 + 边
 * - !existingOnly: 未解析链接 → 幽灵节点（同 Obsidian）
 * - search: 按查询词过滤节点（保留两端都在的边）
 * - folder: 只扫指定文件夹下的文件（空 = 全库）；链接目标/幽灵节点仅限扫描范围内文件产生
 */
export async function buildGraph(app: App, q: GraphQuery): Promise<{ nodes: GNode[]; links: GLink[] }> {
  const nodes: GNode[] = [];
  const links: GLink[] = [];
  // 扫描范围：归一化后拼前缀；空 = 整个仓库（现有行为）
  const folderBase = (q.folder ?? '').trim().replace(/^\/+|\/+$/g, '');
  const prefix = folderBase ? `${folderBase}/` : '';
  const inScope = (path: string) => !prefix || path.startsWith(prefix);
  // 排除隐藏目录与 .trash（同原生图谱行为）
  const mdFiles = app.vault
    .getMarkdownFiles()
    .filter((f) => !f.path.split('/').some((seg) => seg.startsWith('.')))
    .filter((f) => inScope(f.path));

  // 1) 收集每个文件的标签
  const fileTags = new Map<string, string[]>();
  const tagMembers = new Map<string, Set<string>>();
  for (const f of mdFiles) {
    const cache = app.metadataCache.getFileCache(f);
    const tags: string[] = [];
    if (cache?.tags) {
      for (const t of cache.tags) tags.push(t.tag.replace(/^#/, ''));
    }
    const fm = cache?.frontmatter?.tags;
    if (fm) {
      const list = Array.isArray(fm) ? fm : String(fm).split(/[,\s]+/);
      for (const t of list) {
        const s = String(t).trim().replace(/^#/, '');
        if (s) tags.push(s);
      }
    }
    fileTags.set(f.path, tags);
    for (const t of tags) {
      let set = tagMembers.get(t);
      if (!set) {
        set = new Set();
        tagMembers.set(t, set);
      }
      set.add(f.path);
    }
  }

  // 2) 文件节点
  for (const f of mdFiles) {
    nodes.push({ id: f.path, kind: 'file', label: f.basename, path: f.path, tags: fileTags.get(f.path) });
  }

  // 3) md ↔ md 已解析双链（含 [[链接]] 与 ![[嵌入]]）
  const mdSet = new Set(mdFiles.map((f) => f.path));
  const resolved = app.metadataCache.resolvedLinks;
  for (const [src, tgts] of Object.entries(resolved)) {
    if (!mdSet.has(src)) continue;
    for (const tgt of Object.keys(tgts)) {
      if (mdSet.has(tgt)) links.push({ source: src, target: tgt });
    }
  }

  // 3.5) frontmatter 属性中的链接（原生图谱也会计入）
  for (const f of mdFiles) {
    const cache = app.metadataCache.getFileCache(f) as
      | (ReturnType<typeof app.metadataCache.getFileCache> & { frontmatterLinks?: { link: string }[] })
      | null;
    const fml = cache?.frontmatterLinks;
    if (!fml) continue;
    for (const fl of fml) {
      const dest = app.metadataCache.getFirstLinkpathDest(fl.link, f.path);
      if (dest && dest.extension === 'md' && mdSet.has(dest.path)) {
        links.push({ source: f.path, target: dest.path });
      }
    }
  }

  // 3.7) 标准 Markdown 链接 [文本](路径)：原生图谱不画这类链接，为对齐原生不扫描。
  // 实测：核心观点总览等文件含 200+ 条 md 链接，扫入后会造出原生不存在的巨型枢纽，破坏布局均匀性

  // 4) 标签节点
  if (q.showTags) {
    for (const [t, members] of tagMembers) {
      nodes.push({ id: `tag:#${t}`, kind: 'tag', label: `#${t}`, tags: [t] });
      for (const p of members) links.push({ source: p, target: `tag:#${t}` });
    }
  }

  // 5) 附件节点（被 embed/link 引用的非 md 文件）
  if (q.showAttachments) {
    const attachments = new Map<string, string>();
    for (const f of mdFiles) {
      const cache = app.metadataCache.getFileCache(f);
      const refs = [...(cache?.embeds ?? []), ...(cache?.links ?? [])];
      for (const r of refs) {
        const dest = app.metadataCache.getFirstLinkpathDest(r.link, f.path);
        if (dest && dest.extension !== 'md') {
          attachments.set(dest.path, dest.basename);
          links.push({ source: f.path, target: dest.path });
        }
      }
    }
    for (const [p, name] of attachments) {
      nodes.push({ id: p, kind: 'attachment', label: name, path: p });
    }
  }

  // 6) 幽灵节点（未解析链接，即指向不存在文件的链接）
  if (!q.existingOnly) {
    const unresolved = app.metadataCache.unresolvedLinks;
    const seen = new Set<string>();
    for (const [src, tgts] of Object.entries(unresolved)) {
      if (!mdSet.has(src)) continue; // 文件夹模式下不泄漏扫描范围外的幽灵链接
      for (const linkText of Object.keys(tgts)) {
        const gid = `ghost:${linkText}`;
        if (!seen.has(gid)) {
          seen.add(gid);
          nodes.push({ id: gid, kind: 'ghost', label: linkText });
        }
        links.push({ source: src, target: gid });
      }
    }
  }

  // 7) 搜索过滤 + 边去重（同一对节点多条链接只保留一条，避免弹簧叠加拉得过紧/虚增连接数）
  const tokens = parseTokens(q.search);
  const kept = tokens.length ? nodes.filter((n) => tokensMatch(n, tokens)) : nodes;
  const keptIds = new Set(kept.map((n) => n.id));
  const seenPair = new Set<string>();
  const dedupedLinks: GLink[] = [];
  for (const l of links) {
    if (!keptIds.has(l.source) || !keptIds.has(l.target)) continue;
    const key = l.source < l.target ? `${l.source}|${l.target}` : `${l.target}|${l.source}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    dedupedLinks.push(l);
  }
  return { nodes: kept, links: dedupedLinks };
}
