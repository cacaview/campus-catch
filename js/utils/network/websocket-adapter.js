// 原生 WebSocket 适配器（超时/状态机语义与源 wx.connectSocket 版一致）
class WebSocketAdapter {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.onMessageCallback = null;
    this.onCloseCallback = null;
    this.onErrorCallback = null;
    this.onOpenCallback = null;
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      console.log('[WebSocketAdapter] Connecting to:', url);
      this.disconnect();
      let targetUrl = url;
      if (!targetUrl.startsWith('ws://') && !targetUrl.startsWith('wss://')) targetUrl = 'wss://' + targetUrl;

      let settled = false;
      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        if (this._connectTimeout) {
          clearTimeout(this._connectTimeout);
          this._connectTimeout = null;
        }
        fn(val);
      };
      if (this._connectTimeout) clearTimeout(this._connectTimeout);
      this._connectTimeout = setTimeout(() => {
        settle(reject, new Error('连接超时（10 秒）：请检查地址是否正确、服务器是否已启动'));
        try {
          if (this.socket) this.socket.close();
        } catch (e) {}
      }, 10000);

      try {
        this.socket = new WebSocket(targetUrl);
        this.socket.onopen = () => {
          console.log('[WebSocketAdapter] Connected successfully');
          this.isConnected = true;
          if (this.onOpenCallback) this.onOpenCallback({});
          settle(resolve, true);
        };
        this.socket.onmessage = (e) => {
          if (this.onMessageCallback) this.onMessageCallback(e.data);
        };
        this.socket.onerror = (e) => {
          console.error('[WebSocketAdapter] Socket error:', e);
          this.isConnected = false;
          if (this.onErrorCallback) this.onErrorCallback(e);
          settle(reject, new Error('连接失败：服务不可达（检查 wss:// 地址与服务器状态）'));
        };
        this.socket.onclose = (e) => {
          console.log('[WebSocketAdapter] Socket closed:', e.code);
          this.isConnected = false;
          if (this.onCloseCallback) this.onCloseCallback(e);
          if (!settled) settle(reject, new Error('连接已关闭（服务可能未启动）'));
        };
      } catch (err) {
        console.error('[WebSocketAdapter] Connection error:', err);
        this.isConnected = false;
        settle(reject, err);
      }
    });
  }

  send(data) {
    if (!this.isConnected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.warn('[WebSocketAdapter] Cannot send: not connected');
      return false;
    }
    try {
      this.socket.send(typeof data === 'string' ? data : JSON.stringify(data));
      return true;
    } catch (err) {
      console.error('[WebSocketAdapter] Send exception:', err);
      return false;
    }
  }

  disconnect() {
    if (this.socket) {
      // 主动断开：先摘掉事件回调，close 回调不再当「意外断开」上报（否则触发重连循环）
      const s = this.socket;
      this.socket = null;
      s.onopen = s.onmessage = s.onerror = s.onclose = null;
      try {
        s.close(1000, 'Normal disconnect');
      } catch (e) {}
    }
    this.isConnected = false;
  }
}
export default WebSocketAdapter;
