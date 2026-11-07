from pathlib import Path
import hashlib
import pymupdf
from .store import atomic_json


def extract_pdf(source: Path, target: Path, max_pages=300, progress=lambda _: None):
    """Read every page, preserving page evidence and safe local visual candidates."""
    target.mkdir(parents=True, exist_ok=True)
    pages_dir = target / 'pages'
    images_dir = target / 'images'
    pages_dir.mkdir(exist_ok=True)
    images_dir.mkdir(exist_ok=True)
    pages, images, seen = [], [], {}
    with pymupdf.open(source) as doc:
        if not doc.is_pdf or doc.needs_pass:
            raise ValueError('仅支持未加密 PDF；请提供可读取的手册')
        if len(doc) == 0 or len(doc) > max_pages:
            raise ValueError(f'PDF 页数须为 1–{max_pages} 页')
        for index, page in enumerate(doc):
            number = index + 1
            progress(f'正在读取第 {number} / {len(doc)} 页')
            # Bound pixel dimensions even for extreme page dimensions.
            if page.rect.width <= 0 or page.rect.height <= 0:
                raise ValueError(f'第 {number} 页尺寸无效')
            scale = min(1.6, 1600 / max(page.rect.width, page.rect.height))
            page_file = f'pages/{number:04d}.png'
            page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).save(target / page_file)
            text = page.get_text('text', sort=True)
            links = [l['uri'] for l in page.get_links() if l.get('uri', '').startswith(('https://', 'http://'))]
            page_images = []
            # Crop displayed images: preserves transparency/masks and vector overlays.
            for img_index, info in enumerate(page.get_image_info()):
                rect = pymupdf.Rect(info['bbox']) & page.rect
                if rect.width < 100 or rect.height < 65:
                    continue
                crop_scale = min(2, 1600 / max(rect.width, rect.height))
                pix = page.get_pixmap(matrix=pymupdf.Matrix(crop_scale, crop_scale), clip=rect, alpha=False)
                raw = pix.tobytes('png')
                digest = hashlib.sha256(raw).hexdigest()
                if digest in seen:
                    page_images.append(seen[digest])
                    continue
                image_id = f'p{number:03d}-img{img_index+1:02d}'
                path = f'images/{image_id}.png'
                (target / path).write_bytes(raw)
                images.append({'id':image_id, 'page':number, 'path':path, 'width':pix.width, 'height':pix.height})
                seen[digest] = image_id
                page_images.append(image_id)
            # Page image is a valid fallback when UI is vector-drawn or fragmented.
            images.append({'id':f'page-{number}', 'page':number, 'path':page_file, 'width':round(page.rect.width*scale), 'height':round(page.rect.height*scale), 'kind':'page'})
            pages.append({'number':number, 'text':text, 'image':page_file, 'image_ids':page_images, 'links':links})
    result = {'page_count':len(pages), 'pages':pages, 'images':images,
              'warnings': ['部分页面无可提取文字，必须通过视觉模型读取'] if any(len(p['text'].strip()) < 30 for p in pages) else []}
    atomic_json(target / 'extraction.json', result)
    (target / 'extracted.txt').write_text('\n\n'.join(f"--- 第 {p['number']} 页 ---\n{p['text']}" for p in pages), encoding='utf-8')
    return result
