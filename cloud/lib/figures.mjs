const figure = /^!\[([^\[\]\n]{1,100})\]\((page-(\d+)#crop=(\d+),(\d+),(\d+),(\d+))\)$/;

export function detailParts(markdown) {
  const parts = [];
  const seen = new Set();
  let lines = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('![')) {
      lines.push(line);
      continue;
    }
    const match = line.trim().match(figure);
    if (!match) throw new Error('正文插图需要有效的手册局部图和图注。');
    const [, caption, id, page, ...coordinates] = match;
    const [x, y, width, height] = coordinates.map(Number);
    if (x + width > 100 || y + height > 100 || width < 3 || height < 3 ||
        (width === 100 && height === 100) || seen.has(id) || seen.size >= 6) {
      throw new Error('正文最多放六张不重复的手册局部图，裁剪区域需在页面内。');
    }
    seen.add(id);
    if (lines.length) parts.push({kind:'text', text:lines.join('\n')});
    lines = [];
    parts.push({kind:'figure', id, page:Number(page), caption, crop:[x,y,width,height]});
  }
  if (lines.length) parts.push({kind:'text', text:lines.join('\n')});
  return parts;
}
