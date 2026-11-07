import re


FIGURE = re.compile(r'^!\[([^\[\]\n]{1,100})\]\(([A-Za-z0-9_-]{1,80})\)$')


def detail_parts(markdown):
    """Yield text runs and internal image references in document order."""
    lines = []
    for line in markdown.splitlines():
        match = FIGURE.fullmatch(line.strip())
        if match:
            if lines:
                yield '\n'.join(lines), None
                lines = []
            yield match[1], match[2]
        elif line.strip().startswith('!['):
            raise ValueError('说明插图必须使用手册候选图片 ID 和简短图注')
        else:
            lines.append(line)
    if lines:
        yield '\n'.join(lines), None


def detail_figures(markdown, extraction):
    candidates = {image['id']: image for image in extraction['images'] if image.get('kind') != 'page'}
    selected = {}
    for _, image_id in detail_parts(markdown):
        if not image_id:
            continue
        if image_id not in candidates or image_id in selected or len(selected) >= 6:
            raise ValueError('详细说明最多引用六张不重复的手册局部图')
        selected[image_id] = candidates[image_id]
    return selected
