#!/usr/bin/env python3
"""
游戏构建产物的静态文件服务器。

为什么用 Python 而不是 Node 或 nginx：5060 Ti 上现成可用的运行时只有
Python 3.12，装 Node 或 nginx 都要联网拉包（那台机器走代理，不稳定）。
这个服务器零依赖、单文件，功能够用，改起来也直观。

功能：
  - gzip 压缩（结果缓存在内存，构建产物不会变，压一次反复用）
  - 带 hash 的资源长缓存，index.html 不缓存
  - 单页应用回退
  - 防目录穿越

用法：
    python3 serve.py --port 8100 --root ./dist
"""

import argparse
import gzip
import http.server
import io
import os
import socket
import sys
import threading
import time
from pathlib import Path

# 这些 MIME 类型值得压缩
COMPRESSIBLE = {
    "text/html",
    "text/css",
    "text/plain",
    "text/javascript",
    "application/javascript",
    "application/json",
    "image/svg+xml",
}

# 压缩结果缓存。构建产物内容固定，没必要每次请求重压一遍。
_gzip_cache: dict[Path, tuple[bytes, int]] = {}
_cache_lock = threading.Lock()
GZIP_MIN_SIZE = 1024


class GameHandler(http.server.SimpleHTTPRequestHandler):
    """托管构建产物的请求处理器。"""

    server_version = "ZeldaGameServer/1.0"
    root: Path = Path(".")

    def do_GET(self) -> None:  # noqa: N802 (遵循 http.server 的命名约定)
        self._serve(include_body=True)

    def do_HEAD(self) -> None:  # noqa: N802
        self._serve(include_body=False)

    def _resolve(self) -> Path | None:
        """把请求路径解析成磁盘文件，返回 None 表示应当 404。"""
        raw = self.path.split("?", 1)[0].split("#", 1)[0]
        # 去掉查询串后做 URL 解码
        from urllib.parse import unquote

        raw = unquote(raw)
        if raw.endswith("/"):
            raw += "index.html"

        root = self.root.resolve()
        candidate = (root / raw.lstrip("/")).resolve()

        # 防目录穿越：解析后的路径必须仍在根目录内
        if candidate != root and root not in candidate.parents:
            return None

        if candidate.is_dir():
            candidate = candidate / "index.html"

        if not candidate.is_file():
            # 单页应用回退：未知路径交给前端路由
            fallback = root / "index.html"
            return fallback if fallback.is_file() else None

        return candidate

    def _serve(self, include_body: bool) -> None:
        file_path = self._resolve()
        if file_path is None:
            self.send_error(404, "Not Found")
            return

        try:
            stat = file_path.stat()
        except OSError:
            self.send_error(404, "Not Found")
            return

        content_type = self.guess_type(str(file_path))
        use_gzip = (
            content_type in COMPRESSIBLE
            and stat.st_size >= GZIP_MIN_SIZE
            and "gzip" in self.headers.get("Accept-Encoding", "")
        )

        body: bytes | None = None
        if use_gzip:
            body = self._gzip_cached(file_path, stat.st_mtime)

        self.send_response(200)
        self.send_header("Content-Type", content_type)

        if body is not None:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
        else:
            self.send_header("Content-Length", str(stat.st_size))

        # 带内容 hash 的资源永不改变，可以长缓存；入口文件必须每次校验
        if "/assets/" in str(file_path):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")

        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()

        if not include_body:
            return

        if body is not None:
            self.wfile.write(body)
        else:
            with open(file_path, "rb") as fh:
                self.copyfile(fh, self.wfile)

    def _gzip_cached(self, path: Path, mtime: float) -> bytes:
        """按 mtime 缓存压缩结果；构建产物换了内容自然会失效。"""
        with _cache_lock:
            hit = _gzip_cache.get(path)
            if hit is not None and hit[1] == mtime:
                return hit[0]

        buf = io.BytesIO()
        with open(path, "rb") as fh, gzip.GzipFile(
            fileobj=buf, mode="wb", compresslevel=6
        ) as gz:
            while chunk := fh.read(262144):
                gz.write(chunk)
        data = buf.getvalue()

        with _cache_lock:
            _gzip_cache[path] = (data, mtime)
        return data

    def log_message(self, fmt: str, *args) -> None:
        # 默认实现每条请求写一行，日志会很快膨胀；只记非 200 的
        status = args[1] if len(args) > 1 else ""
        if str(status).startswith("2"):
            return
        sys.stderr.write(
            "%s - %s\n" % (self.address_string(), fmt % args)
        )


class ThreadingHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def local_ips() -> list[str]:
    """列出本机可用的 IPv4 地址，方便确认从哪访问。"""
    ips = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            addr = info[4][0]
            if addr not in ips and not addr.startswith("127."):
                ips.append(addr)
    except OSError:
        pass
    return ips


def main() -> int:
    parser = argparse.ArgumentParser(description="游戏静态资源服务器")
    parser.add_argument("--port", type=int, default=8100)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--root", default=str(Path(__file__).parent / "dist"))
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"错误：资源目录不存在 {root}", file=sys.stderr)
        return 1

    if not (root / "index.html").is_file():
        print(f"警告：{root} 下没有 index.html，请先执行构建", file=sys.stderr)

    GameHandler.root = root

    try:
        httpd = ThreadingHTTPServer((args.host, args.port), GameHandler)
    except OSError as exc:
        print(f"错误：无法绑定 {args.host}:{args.port} —— {exc}", file=sys.stderr)
        return 1

    print(f"资源目录: {root}")
    print(f"监听:     {args.host}:{args.port}")
    for ip in local_ips():
        print(f"  访问:   http://{ip}:{args.port}/")
    print(f"启动于 {time.strftime('%Y-%m-%d %H:%M:%S')}", flush=True)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
