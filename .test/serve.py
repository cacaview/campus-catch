#!/usr/bin/env python3
"""本地无缓存静态服务器（仅联调）：Cache-Control: no-store，避免 ESM 模块内存缓存干扰。
用法：python3 serve.py [port]（默认 8125）"""
import http.server, socketserver, os, sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # 项目根目录
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8125

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()
    def log_message(self, *a):
        pass  # 静默

socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f'serving {os.getcwd()} on http://127.0.0.1:{PORT} (no-store)', flush=True)
    httpd.serve_forever()
