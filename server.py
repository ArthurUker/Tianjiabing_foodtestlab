#!/usr/bin/env python3
"""
开发用 HTTP 服务器 - 禁用所有缓存
使用方法: python3 server.py [端口号]
默认端口: 3001
"""
import http.server
import sys


class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):
        # 只打印非 200 的请求，减少噪音
        if args and args[1] != '200':
            super().log_message(format, *args)


port = int(sys.argv[1]) if len(sys.argv) > 1 else 3001
print(f'🚀 开发服务器启动在 http://localhost:{port}')
print(f'📦 已禁用 HTTP 缓存（Cache-Control: no-store）')
print(f'⌨️  按 Ctrl+C 停止')

httpd = http.server.HTTPServer(('', port), NoCacheHTTPRequestHandler)
httpd.serve_forever()
