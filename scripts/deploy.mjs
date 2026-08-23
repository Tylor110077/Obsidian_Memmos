// 构建产物部署到 Obsidian Vault 插件目录
// 用法: node scripts/deploy.mjs [vault路径]
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const vault = process.argv[2] || process.env.OBSIDIAN_VAULT || '/Users/tylor/Note/OBISIDIAN';
const target = join(vault, '.obsidian', 'plugins', 'memos-graph');

if (!existsSync(join(vault, '.obsidian'))) {
  console.error(`不是有效的 Vault: ${vault}`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });
copyFileSync('main.js', join(target, 'main.js'));
copyFileSync('manifest.json', join(target, 'manifest.json'));

// esbuild 会把 css import 输出到 main.css，与本地 styles.css 合并为插件 styles.css
let css = '';
if (existsSync('main.css')) css += readFileSync('main.css', 'utf8');
if (existsSync('styles.css')) css += '\n' + readFileSync('styles.css', 'utf8');
writeFileSync(join(target, 'styles.css'), css);

console.log(`✓ 已部署到 ${target}`);
console.log('  在 Obsidian 中: 设置 → 第三方插件 → 启用 "Memmos Graph"（若已启用需先禁用再启用或重载）');
