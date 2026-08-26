/**
 * 图片画廊（用户要求：像手机上看帖子一样，点击上一张/下一张，不用上下滑动）：
 * 把同一篇 md 里连续排列的图片段落（剪藏笔记的封面+图集就是这种结构）
 * 折叠成「一次看一张」的浏览组件，左/右 30% 区域点击切图，悬停出箭头。
 * 只在同步文件夹内生效（main.ts 按路径过滤后才调用本组件）。
 */

/** Markdown 后处理器：找到「相邻且段落里只有一张图」的连续图组，替换为画廊 */
export function wrapImageGroups(root: HTMLElement): void {
  const ps = Array.from(root.querySelectorAll('p'));
  let i = 0;
  while (i < ps.length) {
    if (!isImageParagraph(ps[i])) {
      i++;
      continue;
    }
    const group = [ps[i]];
    let j = i + 1;
    while (j < ps.length && isImageParagraph(ps[j])) {
      group.push(ps[j]);
      j++;
    }
    // 单张图保持原样（没有前后可切）；连续两张及以上才折叠成画廊
    if (group.length >= 2) buildGallery(group);
    i = j;
  }
}

/** 段落「只含一张图、无文字与其他行内元素」才算图段落（有说明文字的图不参与） */
function isImageParagraph(p: HTMLParagraphElement): boolean {
  if (p.querySelectorAll('img').length !== 1) return false;
  if (p.querySelector('br, a, em, strong, code, span') !== null) return false;
  return !p.textContent?.trim();
}

function buildGallery(group: HTMLParagraphElement[]): void {
  // 移动原图元素而非克隆：Obsidian 1.13 原生「点击放大/悬停放大按钮」绑定在原图节点上，
  // 克隆会把这些行为弄丢（用户反馈：点图不跳转、放大按钮失效）
  const imgs = group.map((p) => p.querySelector('img') as HTMLImageElement);

  const wrap = document.createElement('div');
  wrap.className = 'memmos-gallery';

  const stage = document.createElement('div');
  stage.className = 'memmos-gallery-stage';
  stage.setAttribute('title', '点击左侧上一张 · 其他区域下一张');

  const counter = document.createElement('div');
  counter.className = 'memmos-gallery-counter';

  const prev = document.createElement('button');
  prev.className = 'memmos-gallery-nav memmos-gallery-prev';
  prev.textContent = '‹';
  prev.setAttribute('aria-label', '上一张');
  const next = document.createElement('button');
  next.className = 'memmos-gallery-nav memmos-gallery-next';
  next.textContent = '›';
  next.setAttribute('aria-label', '下一张');

  let idx = 0;
  const show = () => {
    stage.textContent = '';
    stage.appendChild(imgs[idx]);
    counter.textContent = `${idx + 1} / ${imgs.length}`;
    prev.disabled = idx === 0;
    next.disabled = idx === imgs.length - 1;
  };
  const go = (d: number) => {
    const t = idx + d;
    if (t < 0 || t >= imgs.length) return;
    idx = t;
    show();
  };
  prev.addEventListener('click', (e) => {
    e.stopPropagation();
    go(-1);
  });
  next.addEventListener('click', (e) => {
    e.stopPropagation();
    go(1);
  });
  // 点击切换：左 30% 上一张，其余区域下一张；stopPropagation 避免 Obsidian 原生点击放大抢先；
  // 按钮（Obsidian 原生放大按钮/本组件的‹›）不拦截，交给各自处理
  stage.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('button')) return;
    const rect = stage.getBoundingClientRect();
    const x = e.clientX - rect.left;
    e.stopPropagation();
    if (x < rect.width * 0.3) go(-1);
    else go(1);
  });

  wrap.append(stage, counter, prev, next);
  show();

  group[0].replaceWith(wrap);
  group.slice(1).forEach((p) => p.remove());
}
