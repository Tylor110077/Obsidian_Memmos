import * as http from 'http';
import * as dgram from 'dgram';
import * as crypto from 'crypto';
import * as os from 'os';
import { Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type MemosPlugin from '../main';
import { normalizeFolder } from '../settings';

/**
 * 设备配对与双向同步服务（Android Memmos ↔ Obsidian memos-graph）
 *
 * 协议（JSON，除 /pair 外需带 X-Memmos-Token 头）：
 *   GET  /pair?code=xxxxxx        配对：校验 6 位码，返回长效 token 与同步根目录
 *   GET  /api/inventory            同步范围内文件清单 [{path, sha256, mtime}]
 *   GET  /api/file?path=...        下载单个 md 文件内容
 *   POST /api/file                 上传 md {path, content}（限范围内，自动建目录）
 *   POST /api/delete               删除 {path}（手机为唯一真源时的联删：md 与媒体附件）
 *
 * 同步范围 = 插件设置 sync.syncFolder（默认 Memmos graph；空 = 全库）。
 * 去重靠内容 sha256：两端各自比对清单只传差异（判定在客户端，服务端只供清单与读写）。
 */

export const SYNC_PORT_DEFAULT = 28422;

export interface SyncSettings {
  syncEnabled: boolean;
  syncPort: number;
  syncToken: string;
  pairCode: string;
  /** 同步文件夹（独立于图谱扫描范围；手机端只同步此文件夹内的 md） */
  syncFolder: string;
}

export const DISCOVERY_PORT = 28423;
export const DISCOVERY_REQ = 'MEMMOS_DISCOVER_V1';

export class SyncServer {
  private server: http.Server | null = null;
  private discovery: dgram.Socket | null = null;
  private plugin: MemosPlugin;

  constructor(plugin: MemosPlugin) {
    this.plugin = plugin;
  }

  private get s(): SyncSettings {
    return this.plugin.settings.sync;
  }

  get port(): number {
    return this.s?.syncPort || SYNC_PORT_DEFAULT;
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** 配对码：未生成时现场生成 6 位数字 */
  ensurePairCode(): string {
    if (!this.s.pairCode || this.s.pairCode.length !== 6) {
      this.s.pairCode = String(crypto.randomInt(100000, 999999));
      void this.plugin.saveSettings();
    }
    return this.s.pairCode;
  }

  private ensureToken(): string {
    if (!this.s.syncToken) {
      this.s.syncToken = crypto.randomBytes(24).toString('hex');
      void this.plugin.saveSettings();
    }
    return this.s.syncToken;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.ensurePairCode();
    this.ensureToken();
    const port = this.port;
    const srv = http.createServer((req, res) => {
      // 路由 handler 均为 async，异常统一兜成 500
      this.handle(req, res).catch((e) => {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: String(e) }));
        } catch { /* 已销毁 */ }
      });
    });
    // 0.0.0.0：局域网内手机可直连；配对码 + token 双闸兜住陌生访问
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '0.0.0.0', () => resolve());
    });
    this.server = srv;
    this.startDiscovery();
    new Notice(`Memmos 同步已开启 :${port}（配对码 ${this.s.pairCode}）`);
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.discovery?.close();
    this.discovery = null;
  }

  /**
   * UDP 发现服务：收到探测包（MEMMOS_DISCOVER_V1）即向来源单播回报
   * 设备名 / TCP 端口 / 配对码，供手机端列出可配对设备。
   */
  private startDiscovery() {
    if (this.discovery) return;
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => { /* 端口被占等：发现不可用不影响 TCP 同步 */ });
    sock.on('message', (msg, rinfo) => {
      if (msg.toString().trim() !== DISCOVERY_REQ) return;
      const payload = Buffer.from(
        JSON.stringify({
          service: 'memmos-sync',
          name: `${this.plugin.app.vault.getName()}（Obsidian）`,
          host: rinfo.address,
          port: this.port,
          code: this.ensurePairCode(),
        }),
      );
      sock.send(payload, rinfo.port, rinfo.address, () => {});
    });
    try {
      sock.bind(DISCOVERY_PORT, () => {});
      this.discovery = sock;
    } catch { /* 端口占用：发现服务跳过 */ }
  }

  /* ───────── 路由 ───────── */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'local'}`);
    const send = (code: number, body: unknown) => {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'X-Memmos-Token, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      return void res.end();
    }

    if (url.pathname === '/pair') {
      // 配对无需 token（此时尚未持有），但要配对码
      const code = url.searchParams.get('code') || '';
      if (code !== this.s.pairCode) return void send(403, { error: '配对码不正确' });
      return void send(200, { token: this.ensureToken(), folder: this.syncRoot() });
    }

    if ((req.headers['x-memmos-token'] || '') !== this.s.syncToken) {
      return void send(401, { error: '未授权' });
    }

    if (req.method === 'GET' && url.pathname === '/api/inventory') {
      return void send(200, { files: await this.inventory() });
    }
    if (req.method === 'GET' && url.pathname === '/api/file') {
      return void this.serveFile(url.searchParams.get('path') || '', send);
    }
    if (req.method === 'POST' && url.pathname === '/api/file') {
      return this.receiveFile(req, send);
    }
    // 二进制（图片/视频）：{path, base64} → 写入 vault；GET 同路径 → {base64}
    if (req.method === 'POST' && url.pathname === '/api/binary') {
      return this.receiveBinary(req, send);
    }
    if (req.method === 'GET' && url.pathname === '/api/binary') {
      return void this.serveBinary(url.searchParams.get('path') || '', send);
    }
    if (req.method === 'POST' && url.pathname === '/api/delete') {
      return this.receiveDelete(req, send);
    }
    send(404, { error: 'unknown route' });
  }

  /* ───────── 同步范围 ───────── */

  private syncRoot(): string {
    // 同步范围独立于图谱扫描范围（用户要求：只同步 Memmos graph 文件夹，非全库）
    return normalizeFolder(this.plugin.settings.sync.syncFolder || 'Memmos graph');
  }

  private inScope(path: string): boolean {
    const root = this.syncRoot();
    return !root || path.startsWith(`${root}/`);
  }

  /** 同步支持的文件扩展名白名单（md 笔记 + 常见附件） */
  private static readonly SYNC_EXTS = new Set([
    'md', 'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'csv',
    'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'mp3', 'wav', 'txt',
  ]);

  private syncable(f: TFile): boolean {
    if (!this.inScope(f.path)) return false;
    const ext = f.extension.toLowerCase();
    return SyncServer.SYNC_EXTS.has(ext);
  }

  /** 清单：范围内全部可同步文件的 path + 内容指纹（md 用文本指纹，二进制用字节指纹） */
  private async inventory(): Promise<{ path: string; sha256: string; mtime: number }[]> {
    const out: { path: string; sha256: string; mtime: number }[] = [];
    for (const f of this.plugin.app.vault.getFiles()) {
      if (!this.syncable(f)) continue;
      const isMd = f.extension.toLowerCase() === 'md';
      const hash = isMd
        ? crypto.createHash('sha256').update(await this.plugin.app.vault.cachedRead(f)).digest('hex').slice(0, 16)
        : crypto.createHash('sha256').update(Buffer.from(await this.plugin.app.vault.readBinary(f))).digest('hex').slice(0, 16);
      out.push({ path: f.path, sha256: hash, mtime: f.stat.mtime });
    }
    return out;
  }

  private async serveFile(path: string, send: (code: number, body: unknown) => void) {
    const norm = normalizePath(decodeURIComponent(path));
    const f = this.plugin.app.vault.getAbstractFileByPath(norm);
    if (!(f instanceof TFile) || !this.inScope(f.path)) return send(404, { error: 'file not found' });
    if (f.extension.toLowerCase() === 'md') {
      return send(200, { path: f.path, content: await this.plugin.app.vault.cachedRead(f) });
    }
    // 二进制附件走 base64（与 /api/binary GET 同格式）
    const ab = await this.plugin.app.vault.readBinary(f);
    return send(200, { path: f.path, base64: Buffer.from(ab).toString('base64') });
  }

  private async serveBinary(path: string, send: (code: number, body: unknown) => void) {
    const norm = normalizePath(decodeURIComponent(path));
    const f = this.plugin.app.vault.getAbstractFileByPath(norm);
    if (!(f instanceof TFile) || !this.inScope(f.path)) return send(404, { error: 'file not found' });
    const ab = await this.plugin.app.vault.readBinary(f);
    // ArrayBuffer → Buffer 转 base64（ArrayBuffer 自身的 toString 不支持 base64）
    send(200, { path: f.path, base64: Buffer.from(ab).toString('base64') });
  }

  private receiveBinary(
    req: http.IncomingMessage,
    send: (code: number, body: unknown) => void,
  ) {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 200 * 1024 * 1024) { // 上限 200MB：视频文件
        send(413, { error: 'too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      void (async () => {
        try {
          const { path, base64 } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof path !== 'string' || typeof base64 !== 'string') {
            return send(400, { error: 'bad payload' });
          }
          const norm = normalizePath(decodeURIComponent(path));
          const root = this.syncRoot();
          if (norm.includes('..')) return send(403, { error: 'bad path' });
          if (root && !norm.startsWith(`${root}/`)) return send(403, { error: 'out of sync scope' });
          const nodeBuf = Buffer.from(base64, 'base64');
          // Node Buffer 的 ArrayBuffer 标签为 Uint8Array，需转纯 ArrayBuffer 适配 Obsidian API
          const ab = nodeBuf.buffer.slice(
            nodeBuf.byteOffset,
            nodeBuf.byteOffset + nodeBuf.byteLength,
          ) as ArrayBuffer;
          const existing = this.plugin.app.vault.getAbstractFileByPath(norm);
          if (existing instanceof TFile) {
            await this.plugin.app.vault.modifyBinary(existing, ab);
          } else {
            const parts = norm.split('/');
            parts.pop();
            let cur = '';
            for (const seg of parts) {
              cur = cur ? `${cur}/${seg}` : seg;
              if (!(this.plugin.app.vault.getAbstractFileByPath(cur) instanceof TFolder)) {
                try { await this.plugin.app.vault.createFolder(cur); } catch { /* 已存在 */ }
              }
            }
            await this.plugin.app.vault.createBinary(norm, ab);
          }
          send(200, { ok: true, path: norm });
        } catch (e) {
          send(400, { error: String(e) });
        }
      })();
    });
  }

  /** 删除文件（手机为唯一真源时的联删：note.md + 其媒体附件）。
   *  安全校验与上传一致：同步范围 + 白名单扩展名 + 禁止 .. 逃逸 */
  private receiveDelete(req: http.IncomingMessage, send: (code: number, body: unknown) => void) {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        send(413, { error: 'too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      void (async () => {
        try {
          const { path } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof path !== 'string' || !path) return send(400, { error: 'bad payload' });
          const norm = normalizePath(path);
          if (norm.includes('..')) return send(403, { error: 'bad path' });
          const root = this.syncRoot();
          if (root && !norm.startsWith(`${root}/`)) return send(403, { error: 'out of sync scope' });
          const f = this.plugin.app.vault.getAbstractFileByPath(norm);
          if (!(f instanceof TFile)) return send(404, { error: 'file not found' });
          if (!SyncServer.SYNC_EXTS.has(f.extension.toLowerCase())) {
            return send(403, { error: 'unsupported type' });
          }
          await this.plugin.app.vault.adapter.remove(norm);
          send(200, { ok: true });
        } catch (e) {
          send(500, { error: e instanceof Error ? e.message : String(e) });
        }
      })();
    });
  }

  private receiveFile(
    req: http.IncomingMessage,
    send: (code: number, body: unknown) => void,
  ) {    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { // 上限 5MB：md 文本足够（图片以 URL 引用）
        send(413, { error: 'too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      void (async () => {
        try {
          const { path, content } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof path !== 'string' || typeof content !== 'string') {
            return send(400, { error: 'bad payload' });
          }
          const norm = normalizePath(path);
          // 安全校验：必须落在同步范围内，禁止 .. 逃逸
          const root = this.syncRoot();
          if (norm.includes('..')) return send(403, { error: 'bad path' });
          if (root && !norm.startsWith(`${root}/`)) return send(403, { error: 'out of sync scope' });
          const existing = this.plugin.app.vault.getAbstractFileByPath(norm);
          if (existing instanceof TFile) {
            await this.plugin.app.vault.modify(existing, content);
          } else {
            // 逐级建目录（已存在会抛，忽略并发竞态）
            const parts = norm.split('/');
            parts.pop();
            let cur = '';
            for (const seg of parts) {
              cur = cur ? `${cur}/${seg}` : seg;
              if (!(this.plugin.app.vault.getAbstractFileByPath(cur) instanceof TFolder)) {
                try { await this.plugin.app.vault.createFolder(cur); } catch { /* 已存在 */ }
              }
            }
            await this.plugin.app.vault.create(norm, content);
          }
          send(200, { ok: true, path: norm });
        } catch (e) {
          send(400, { error: String(e) });
        }
      })();
    });
  }

  /** 本机局域网 IPv4（设置页展示，手机端输入用） */
  static localIPs(): string[] {
    const out: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
      }
    }
    return out;
  }
}
