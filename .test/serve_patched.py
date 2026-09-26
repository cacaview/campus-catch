#!/usr/bin/env python3
"""本地无缓存静态服务器 + IAB 环境补丁注入（仅联调，非交付物）。

在 serve.py 基础上：给 index.html 响应注入一段内联脚本，用 setTimeout 模拟
requestAnimationFrame/setInterval —— ZCode IAB 遮挡 webview 中 rAF 完全不触发、
setInterval 会被挂起（环境限制，非 app bug），导致 MapLibre 地图永不渲染。
该补丁模拟真实前台浏览器的帧调度，必须在 app 模块执行前生效，故采用服务端注入。
用法：python3 serve_patched.py [port]（默认 8125）"""
import http.server, socketserver, os, sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # 项目根目录
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8125

PATCH = """<script>
(function(){
  if (window.__envPatched) return; window.__envPatched = true;
  var pendingRAF = new Map(), seq = 1;
  window.requestAnimationFrame = function(cb){
    var id = seq++; var t = setTimeout(function(){ pendingRAF.delete(id); cb(performance.now()); }, 16);
    pendingRAF.set(id, t); return id;
  };
  window.cancelAnimationFrame = function(id){ var t = pendingRAF.get(id); if (t) { clearTimeout(t); pendingRAF.delete(id); } };
  var nativeCI = window.clearInterval.bind(window);
  window.setInterval = function(fn, d){
    var args = Array.prototype.slice.call(arguments, 2); var stop = false;
    function tick(){ if (stop) return; try { fn.apply(null, args); } catch(e){ console.error(e); } setTimeout(tick, d); }
    setTimeout(tick, d);
    return { __patched: true, clear: function(){ stop = true; } };
  };
  window.clearInterval = function(id){ if (id && id.__patched) return id.clear(); return nativeCI(id); };
})();
</script>"""

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def do_GET(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, 'index.html')
        if os.path.basename(path) == 'index.html' and os.path.isfile(path):
            with open(path, 'rb') as f:
                body = f.read().decode('utf-8')
            body = body.replace('<head>', '<head>' + PATCH, 1)
            data = body.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def log_message(self, *a):
        pass  # 静默

socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f'serving {os.getcwd()} on http://127.0.0.1:{PORT} (no-store + env-patch)', flush=True)
    httpd.serve_forever()
