#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量上传文件到 R2 + 自动建商品（自动发货系统）

功能：
  扫描指定文件夹 → 逐个上传到 R2（随机 key）→ 自动创建商品绑定该 key。
  买家付款后即可通过带令牌的下载链接拿到文件；txt/md 还能在线阅读。

与 bulk_import.py 的区别：
  - bulk_import.py：正文读进 D1 数据库（适合短篇、想在线阅读）
  - 本脚本：正文存 R2（适合任何格式/大文件，靠带令牌链接发货）

用法：
  python bulk_upload_r2.py \
    --api https://novel-shop-api.xxx.workers.dev \
    --password 你的后台密码 \
    --dir "D:\\小说文件夹" \
    --price 9.9 --category 都市

依赖：仅 Python 标准库
"""
import os
import re
import sys
import json
import time
import argparse
import urllib.request
import urllib.error

# Windows 控制台 UTF-8 兼容（避免中文乱码）
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Cloudflare 会拦截 Python-urllib 默认 UA（error 1010 / HTTP 403），
# 必须伪装成浏览器 UA 才能通过边缘防护。
BROWSER_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

ALLOWED_EXT = ('txt', 'md', 'epub', 'pdf')
MAX_BYTES = 100 * 1024 * 1024  # Worker 单次请求体上限约 100MB


def api_call(base, path, method='GET', body=None, token=None):
    """JSON 接口调用"""
    url = base.rstrip('/') + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    headers = {'Content-Type': 'application/json', 'User-Agent': BROWSER_UA}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return {'ok': False, 'error': f'HTTP {e.code}: {e.read().decode("utf-8", "ignore")[:200]}'}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def upload_file(base, token, file_path, name):
    """上传单个文件到 R2，返回 {ok, key, size, ext}"""
    url = base.rstrip('/') + '/api/admin/upload?name=' + urllib.request.quote(name)
    with open(file_path, 'rb') as f:
        data = f.read()
    req = urllib.request.Request(url, data=data, headers={
        'Content-Type': 'application/octet-stream',
        'User-Agent': BROWSER_UA,
        'Authorization': 'Bearer ' + token,
    }, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return {'ok': False, 'error': f'HTTP {e.code}: {e.read().decode("utf-8", "ignore")[:200]}'}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def make_slug(name, used):
    """由文件名生成唯一 slug（D1 唯一约束，重复自动加序号）"""
    base = os.path.splitext(name)[0]
    slug = re.sub(r'[^\w\u4e00-\u9fff]+', '-', base).strip('-').lower() or 'item'
    candidate, n = slug, 2
    while candidate in used:
        candidate = f'{slug}-{n}'
        n += 1
    used.add(candidate)
    return candidate


def collect_files(root):
    """递归扫描目标文件夹里的合规文件"""
    found = []
    for dirpath, _, names in os.walk(root):
        for n in names:
            ext = os.path.splitext(n)[1].lower().lstrip('.')
            if ext in ALLOWED_EXT:
                found.append(os.path.join(dirpath, n))
    return sorted(found)


def main():
    ap = argparse.ArgumentParser(description='批量上传文件到 R2 并自动建商品（自动发货）')
    ap.add_argument('--api', required=True, help='Worker 域名，如 https://novel-shop-api.xxx.workers.dev')
    ap.add_argument('--password', required=True, help='后台管理密码')
    ap.add_argument('--dir', required=True, help='待上传文件夹路径')
    ap.add_argument('--price', type=float, default=9.9, help='统一售价（元），默认 9.9')
    ap.add_argument('--original', type=float, default=0, help='划线价（元），默认 0')
    ap.add_argument('--category', default='都市', help='统一分类，默认 都市')
    ap.add_argument('--author', default='佚名', help='默认作者，默认 佚名')
    ap.add_argument('--format', default='', help='强制格式 txt/md/epub/pdf，默认按扩展名推断')
    ap.add_argument('--status', default='on', choices=['on', 'off'], help='商品状态，默认 on 上架')
    ap.add_argument('--limit', type=int, default=0, help='最多处理 N 个文件（0=不限），便于先小批试跑')
    ap.add_argument('--dry-run', action='store_true', help='只列出将要处理的文件，不实际上传')
    ap.add_argument('--delay', type=float, default=0.3, help='每个文件之间的间隔秒数，默认 0.3')
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        print(f'✗ 文件夹不存在：{args.dir}')
        sys.exit(1)

    files = collect_files(args.dir)
    if not files:
        print(f'✗ 文件夹里没有可上传的文件（支持 {"/".join(ALLOWED_EXT)}）')
        sys.exit(1)
    if args.limit > 0:
        files = files[:args.limit]

    print(f'找到 {len(files)} 个待上传文件。')
    if args.dry_run:
        print('--- 干跑模式（不上传）---')
        for i, p in enumerate(files, 1):
            print(f'  [{i}] {os.path.basename(p)}  ({os.path.getsize(p)/1024:.1f} KB)')
        print('干跑结束，未做任何改动。')
        return

    # 登录拿 token
    login = api_call(args.api, '/api/admin/login', 'POST', {'password': args.password})
    if not login.get('ok') or not login.get('token'):
        print(f'✗ 登录失败：{login.get("error", login)}')
        sys.exit(1)
    token = login['token']
    print('登录成功。')

    # 读取已有商品 slug，避免重复建（断点续跑友好）
    existing = api_call(args.api, '/api/admin/products', 'GET', token=token)
    used_slugs = set(x.get('slug', '') for x in existing.get('list', [])) if existing.get('ok') else set()

    ok_count, fail_count = 0, 0
    for i, path in enumerate(files, 1):
        name = os.path.basename(path)
        ext = os.path.splitext(name)[1].lower().lstrip('.')
        size = os.path.getsize(path)
        print(f'[{i}/{len(files)}] {name}  ({size/1024:.1f} KB)', end=' ... ')
        if size > MAX_BYTES:
            print(f'✗ 超过 100MB 上限，跳过')
            fail_count += 1
            continue
        # 1) 上传到 R2
        up = upload_file(args.api, token, path, name)
        if not up.get('ok') or not up.get('key'):
            print(f'✗ 上传失败：{up.get("error", up)}')
            fail_count += 1
            continue
        key = up['key']
        # 2) 建商品绑定该 key
        slug = make_slug(name, used_slugs)
        title = os.path.splitext(name)[0]
        payload = {
            'slug': slug,
            'title': title,
            'author': args.author,
            'category': args.category,
            'price': round(args.price * 100),
            'original_price': round(args.original * 100),
            'file_format': args.format or ext,
            'file_name': name,
            'file_size': size,
            'r2_key': key,
            'content': '',  # 正文留空，付款后靠带令牌链接从 R2 下载/阅读
            'description': f'《{title}》 私密档案，付款后自动发货。',
            'status': args.status,
        }
        created = api_call(args.api, '/api/admin/products', 'POST', payload, token)
        if created.get('ok'):
            print(f'✓ key={key}')
            ok_count += 1
        else:
            print(f'✗ 建商品失败：{created.get("error", created)}（R2 文件已上传，key={key}）')
            fail_count += 1
        if args.delay > 0:
            time.sleep(args.delay)

    print(f'\n完成：成功 {ok_count}/{len(files)}，失败 {fail_count}。')
    print('提示：文件已在 R2，买家付款后拿到带令牌的下载链接；txt/md 可在线阅读。')


if __name__ == '__main__':
    main()
