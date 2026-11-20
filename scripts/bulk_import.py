#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小说批量入库脚本
功能：扫描指定文件夹里的 .txt/.md/.epub 文件，自动读取正文、生成 slug，
      调用后台管理 API 批量创建商品（可设置统一价格/分类）。

用法：
  1) 先确保 Worker 已部署、ADMIN_PASSWORD 已设置
  2) python bulk_import.py --api https://novel-shop-api.xxx.workers.dev \
       --password 你的后台密码 --dir ./novels --price 9.9 --category 都市

依赖：仅标准库（epub 需要 pip install ebooklib 可选）
"""
import os
import re
import sys
import json
import argparse
import urllib.request
import urllib.error

# 视窗控制台 UTF-8 兼容（避免中文乱码）
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass


def api_call(base, path, method='GET', body=None, token=None):
    url = base.rstrip('/') + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return {'ok': False, 'error': f'HTTP {e.code}: {e.read().decode("utf-8", "ignore")[:200]}'}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def make_slug(name):
    base = os.path.splitext(name)[0]
    slug = re.sub(r'[^\w\u4e00-\u9fff]+', '-', base).strip('-').lower()
    return slug or 'novel'


def read_text(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.txt', '.md'):
        for enc in ('utf-8', 'gbk', 'utf-16', 'gb18030'):
            try:
                with open(path, 'r', encoding=enc) as f:
                    return f.read()
            except (UnicodeDecodeError, UnicodeError):
                continue
        return ''
    if ext == '.epub':
        try:
            import ebooklib
            from ebooklib import epub
            book = epub.read_epub(path)
            parts = []
            for item in book.get_items():
                if item.get_type() == ebooklib.ITEM_DOCUMENT:
                    text = item.get_body_content().decode('utf-8', 'ignore')
                    text = re.sub(r'<[^>]+>', '', text)
                    parts.append(text)
            return '\n'.join(parts)
        except ImportError:
            print('  ! 读取 epub 需安装：pip install ebooklib')
            return ''
    return ''


def main():
    ap = argparse.ArgumentParser(description='小说批量入库到自动发货系统')
    ap.add_argument('--api', required=True, help='Worker 域名，如 https://novel-shop-api.xxx.workers.dev')
    ap.add_argument('--password', required=True, help='后台管理密码')
    ap.add_argument('--dir', required=True, help='小说文件夹路径')
    ap.add_argument('--price', type=float, default=9.9, help='统一售价（元），默认 9.9')
    ap.add_argument('--original', type=float, default=0, help='划线价（元），默认 0')
    ap.add_argument('--category', default='都市', help='统一分类，默认 都市')
    ap.add_argument('--author', default='佚名', help='默认作者，默认 佚名')
    ap.add_argument('--drive-prefix', default='', help='网盘链接前缀（可选）：会拼接文件名生成下载链接')
    ap.add_argument('--no-content', action='store_true', help='不写入正文（文件大时可选，仅用网盘链接发货）')
    ap.add_argument('--format', default='', help='强制格式 txt/epub/md/pdf，默认按扩展名推断')
    args = ap.parse_args()

    print('== 登录后台...')
    login = api_call(args.api, '/api/admin/login', 'POST', {'password': args.password})
    if not login.get('ok'):
        print('登录失败：', login.get('error')); return
    token = login['token']
    print('登录成功。')

    files = []
    for root, _, names in os.walk(args.dir):
        for n in names:
            if n.lower().endswith(('.txt', '.md', '.epub')):
                files.append(os.path.join(root, n))
    print(f'找到 {len(files)} 个小说文件。')

    ok_count = 0
    for i, path in enumerate(files, 1):
        name = os.path.basename(path)
        slug = make_slug(name)
        ext = os.path.splitext(name)[1].lower().lstrip('.')
        fmt = args.format or ext
        title = os.path.splitext(name)[0]
        content = '' if args.no_content else read_text(path)
        size = os.path.getsize(path)

        drive_url = ''
        if args.drive_prefix:
            drive_url = args.drive_prefix.rstrip('/') + '/' + urllib.request.quote(name)

        desc = (content[:120].replace('\n', ' ').strip() if content else '') or f'《{title}》 精彩内容，自动发货。'
        payload = {
            'slug': slug, 'title': title, 'author': args.author, 'category': args.category,
            'price': round(args.price * 100), 'original_price': round(args.original * 100),
            'file_format': fmt, 'file_name': name, 'file_size': size,
            'drive_url': drive_url, 'content': content, 'description': desc, 'status': 'on',
        }
        r = api_call(args.api, '/api/admin/products', 'POST', payload, token)
        if r.get('ok'):
            ok_count += 1
            print(f'[{i}/{len(files)}] ✓ {title}')
        else:
            print(f'[{i}/{len(files)}] ✗ {title}: {r.get("error")}')

    print(f'\n完成：成功 {ok_count}/{len(files)} 本。')


if __name__ == '__main__':
    main()
