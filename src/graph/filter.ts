import type { GNode } from './buildGraph';

/** 过滤/分组查询词法：支持 path: / tag: / file: 前缀与 - 取反 */
export interface Token {
  kind: 'text' | 'path' | 'tag' | 'file';
  text: string;
  negate: boolean;
}

export function parseTokens(query: string): Token[] {
  const tokens: Token[] = [];
  for (const raw of query.trim().split(/\s+/)) {
    if (!raw) continue;
    let text = raw;
    let negate = false;
    if (text.startsWith('-') && text.length > 1) {
      negate = true;
      text = text.slice(1);
    }
    let kind: Token['kind'] = 'text';
    for (const p of ['path', 'tag', 'file'] as const) {
      if (text.toLowerCase().startsWith(`${p}:`)) {
        kind = p;
        text = text.slice(p.length + 1);
        break;
      }
    }
    if (text) tokens.push({ kind, text, negate });
  }
  return tokens;
}

function tokenHit(n: GNode, t: Token): boolean {
  const s = t.text.toLowerCase();
  switch (t.kind) {
    case 'path':
      return (n.path ?? '').toLowerCase().includes(s);
    case 'tag':
      return n.kind === 'tag'
        ? n.label.toLowerCase().includes(s)
        : (n.tags ?? []).some((tg) => tg.toLowerCase().includes(s));
    case 'file':
      return n.kind === 'file' && n.label.toLowerCase().includes(s);
    default:
      return (
        n.label.toLowerCase().includes(s) ||
        (n.path ?? '').toLowerCase().includes(s)
      );
  }
}

/** 所有词项都满足（取反词要求不命中）才算匹配 */
export function tokensMatch(n: GNode, tokens: Token[]): boolean {
  for (const t of tokens) {
    const hit = tokenHit(n, t);
    if (t.negate === hit) return false;
  }
  return true;
}
