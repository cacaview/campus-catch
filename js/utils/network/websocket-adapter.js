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
    this.disconnect();
    return new Promise((resolve, reject) => {
      let socket;
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(this._connectTimeout);
        this._connectTimeout = null;
        this._cancelConnect = null;
        fn(value);
      };
      this._cancelConnect = () => settle(reject, new Error('连接已取消'));
      try {
        let targetUrl = url;
        if (!targetUrl.startsWith('ws://') && !targetUrl.startsWith('wss://')) targetUrl = 'wss://' + targetUrl;
        socket = new WebSocket(targetUrl);
        this.socket = socket;
        const current = () => this.socket === socket;
        this._connectTimeout = setTimeout(() => {
          if (!current()) return;
          settle(reject, new Error('连接超时（10 秒）：请检查地址是否正确、服务器是否已启动'));
          this.disconnect();
        }, 10000);
        socket.onopen = () => {
          if (!current()) return;
          this.isConnected = true;
          settle(resolve, true);
          this.onOpenCallback?.({});
        };
        socket.onmessage = e => {
          if (current()) this.onMessageCallback?.(e.data);
        };
        socket.onerror = e => {
          if (!current()) return;
          this.isConnected = false;
          settle(reject, new Error('连接失败：服务不可达（检查 wss:// 地址与服务器状态）'));
          this.onErrorCallback?.(e);
        };
        socket.onclose = e => {
          if (!current()) return;
          this.isConnected = false;
          settle(reject, new Error('连接已关闭（服务可能未启动）'));
          this.onCloseCallback?.(e);
        };
      } catch (error) {
        this.isConnected = false;
        settle(reject, error);
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
    this._cancelConnect?.();
    clearTimeout(this._connectTimeout);
    this._connectTimeout = null;
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
