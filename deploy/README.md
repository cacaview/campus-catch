# 部署到 106.53.199.187

本目录将静态 Web 客户端部署到 Nginx，将房间聊天/语音信令部署为 loopback-only Node relay，并用 Coturn 转发 WebRTC 媒体。浏览器只访问 `https://106.53.199.187/`、`wss://106.53.199.187/ws` 和 `/api/ice-config`。TURN 共享密钥、Certbot 状态和 TLS 私钥仅保存在服务器。

## 端口

腾讯云安全组和主机 nftables 都需要这些入站端口：

| 协议 | 端口 | 用途 |
| --- | --- | --- |
| TCP | 22 | SSH 管理 |
| TCP | 80 | HTTP-01 证书校验及 HTTPS 跳转 |
| TCP | 443 | HTTPS 与 WSS |
| TCP、UDP | 3478 | STUN/TURN 控制连接 |
| UDP | 49160–49200 | Coturn WebRTC relay 媒体范围 |

Node relay 只监听 `127.0.0.1:8081`，不开放公网端口。WebRTC 音频在浏览器之间直接传输；无法直连时使用 Coturn。

公网 ICE 配置按来源 IP 限流，每次签发使用独立临时账号；Coturn 限制每个临时账号 8 个 allocation、全服 64 个 allocation，每个 session 上行/下行各限 64,000 bytes/s，避免匿名访客无限消耗 TURN 资源。

## 1. 安装系统依赖

在 Debian 13 上以 root 执行：

```sh
apt update
apt install --no-install-recommends nodejs npm nginx coturn nftables python3-venv ca-certificates curl rsync openssl
node --version
npm --version
```

安装独立 Certbot venv，避免旧版发行包缺少 Certbot 5.4 的 IP 地址 webroot 支持：

```sh
python3 -m venv /opt/certbot
/opt/certbot/bin/pip install --upgrade pip certbot
/opt/certbot/bin/certbot --version
```

版本必须为 5.4 或更新版本。

本地上传命令使用项目服务器密钥。先在本地项目根目录设置路径，所有传输命令显式指定该密钥：

```sh
KEY_FILE=/Users/user/Downloads/666.pem
```

## 2. 创建服务账户和服务器端密钥

```sh
id -u game-web >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin game-web
install -d -o root -g root -m 0755 /var/www/game-web /var/www/acme/.well-known/acme-challenge /opt/game-web/server
umask 077
secret_tmp=$(mktemp)
openssl rand -hex 32 > "$secret_tmp"
{
    printf 'HOST=127.0.0.1\nPORT=8081\nPUBLIC_IP=106.53.199.187\nTURN_SECRET='
    cat "$secret_tmp"
    printf '\n'
} > /etc/game-web-relay.env
rm -f "$secret_tmp"
chown root:root /etc/game-web-relay.env
chmod 0600 /etc/game-web-relay.env
```

不要将 `/etc/game-web-relay.env`、`/etc/turnserver.conf` 或 `/etc/letsencrypt` 复制回工作区、提交到 Git 或打印到终端。`TURN_SECRET` 只供 relay 和 Coturn 使用。

## 3. 部署静态文件、relay 和 Coturn

从项目根目录在本地执行，将 Web 客户端和 relay 文件分别上传：

```sh
rsync -a -e "ssh -i $KEY_FILE -o IdentitiesOnly=yes" index.html css js vendor root@106.53.199.187:/var/www/game-web/
rsync -a -e "ssh -i $KEY_FILE -o IdentitiesOnly=yes" server/ root@106.53.199.187:/opt/game-web/server/
scp -i "$KEY_FILE" -o IdentitiesOnly=yes deploy/systemd/game-web-relay.service root@106.53.199.187:/etc/systemd/system/game-web-relay.service
scp -i "$KEY_FILE" -o IdentitiesOnly=yes deploy/turnserver.conf.example root@106.53.199.187:/opt/game-web/turnserver.conf.example
```

服务器端整理权限并安装 relay 生产依赖：

```sh
chown -R root:root /var/www/game-web /opt/game-web/server
find /var/www/game-web -type d -exec chmod 0755 {} +
find /var/www/game-web -type f -exec chmod 0644 {} +
cd /opt/game-web/server && npm ci --omit=dev
```

将私网地址替换为实例实际内网 IP（本次检查到 `10.1.0.13`），并从环境文件读取相同的共享密钥生成 Coturn 配置。以下命令不会把密钥输出到终端：

```sh
python3 - <<'PY'
from pathlib import Path

values = {}
for line in Path('/etc/game-web-relay.env').read_text().splitlines():
    key, separator, value = line.partition('=')
    if separator:
        values[key] = value

template = Path('/opt/game-web/turnserver.conf.example').read_text()
config = template.replace('REPLACE_WITH_TURN_SECRET_FROM_game-web-relay.env', values['TURN_SECRET'])
Path('/etc/turnserver.conf').write_text(config)
PY
chown root:turnserver /etc/turnserver.conf
chmod 0640 /etc/turnserver.conf
if grep -q '^TURNSERVER_ENABLED=' /etc/default/coturn; then
    sed -i 's/^TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
else
    printf '\nTURNSERVER_ENABLED=1\n' >> /etc/default/coturn
fi
systemctl enable --now coturn
systemctl daemon-reload
systemctl enable --now game-web-relay.service
systemctl status --no-pager game-web-relay.service coturn
```

Coturn 监听实例当前私网地址 `10.1.0.13`，通过 `external-ip=106.53.199.187/10.1.0.13` 公布公网映射。若实例更换，必须先查实际内网 IP 并同步更新 relay 环境文件和 Coturn 配置。

## 4. 配置主机防火墙

先在腾讯云控制台确认安全组已允许 TCP 22、80、443，TCP/UDP 3478 和 UDP 49160–49200。应用 nftables 前保持当前 SSH 会话打开，并确认 SSH 实际端口为 22。

从本地项目根目录上传规则并先做语法检查：

```sh
scp -i "$KEY_FILE" -o IdentitiesOnly=yes deploy/nftables.conf root@106.53.199.187:/etc/nftables.conf
nft -c -f /etc/nftables.conf
```

另开第二个终端，确认仍能通过同一把 SSH key 建立新连接：

```sh
ssh -i "$KEY_FILE" -o IdentitiesOnly=yes root@106.53.199.187 true
```

只有第二个 SSH 连接成功后，才在第一个会话应用并持久化规则：

```sh
nft -f /etc/nftables.conf
systemctl enable nftables
nft list ruleset
```

该 input 基础链执行主机级默认拒绝策略：未列出的入站端口会被丢弃，即使其他表允许也一样；本配置用于这台独立游戏服务器，其他服务需要入站时应先补入白名单。规则放通 SSH、HTTP(S)、STUN/TURN 控制端口及指定 UDP relay 范围。配置只销毁并重建 `inet game_web` 表，不清空机器上的其他 nftables 表。若 SSH 使用非 22 端口，必须先把对应端口加入配置并重新检查，不能先应用默认规则。

## 5. 先启动 HTTP-01 challenge 站点

从本地项目根目录上传临时 Nginx 配置：

```sh
scp -i "$KEY_FILE" -o IdentitiesOnly=yes deploy/nginx/game-web-acme.conf root@106.53.199.187:/etc/nginx/sites-available/game-web.conf
```

在服务器启用站点并启动 Nginx：

```sh
ln -sfn /etc/nginx/sites-available/game-web.conf /etc/nginx/sites-enabled/game-web.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
```

确认腾讯云安全组和主机防火墙都已放通 TCP 80。由另一台公网设备访问 challenge URL，确保请求到达本机后再继续。

## 6. 申请 IP 证书

先申请隔离命名的 staging 证书，验证 HTTP-01 路径且避免触碰生产证书 lineage：

```sh
/opt/certbot/bin/certbot certonly --staging --webroot --webroot-path /var/www/acme \
    --ip-address 106.53.199.187 --preferred-profile shortlived \
    --cert-name 106.53.199.187-staging --agree-tos --register-unsafely-without-email
```

staging 成功后请求生产证书。IP 证书使用 `shortlived` profile，生命周期约 160 小时：

```sh
/opt/certbot/bin/certbot certonly --webroot --webroot-path /var/www/acme \
    --ip-address 106.53.199.187 --preferred-profile shortlived \
    --cert-name 106.53.199.187 --agree-tos --register-unsafely-without-email
openssl x509 -in /etc/letsencrypt/live/106.53.199.187/fullchain.pem -noout -issuer -dates -ext subjectAltName
```

确认 SAN 含 `IP Address:106.53.199.187` 后再启用 HTTPS Nginx 配置。

## 7. 安装 HTTPS/WSS 配置和续签服务

从本地项目根目录上传最终 Nginx 和 Certbot timer 文件：

```sh
scp -i "$KEY_FILE" -o IdentitiesOnly=yes deploy/nginx/game-web.conf root@106.53.199.187:/etc/nginx/sites-available/game-web.conf
scp -i "$KEY_FILE" -o IdentitiesOnly=yes deploy/systemd/game-web-certbot-renew.service deploy/systemd/game-web-certbot-renew.timer root@106.53.199.187:/etc/systemd/system/
```

服务器端记录 renewal 参数及成功续签后的 Nginx reload hook，然后验证配置：

```sh
/opt/certbot/bin/certbot reconfigure --cert-name 106.53.199.187 \
    --webroot --webroot-path /var/www/acme --ip-address 106.53.199.187 \
    --preferred-profile shortlived --deploy-hook 'systemctl reload nginx'
systemd-analyze verify /etc/systemd/system/game-web-relay.service \
    /etc/systemd/system/game-web-certbot-renew.service \
    /etc/systemd/system/game-web-certbot-renew.timer
nginx -t
systemctl reload nginx
systemctl daemon-reload
systemctl enable --now game-web-certbot-renew.timer
/opt/certbot/bin/certbot renew --dry-run
```

续签 timer 每 6 小时检查一次；Certbot 只在需要时更新短期证书，deploy hook 负责 reload Nginx。查看 timer 与最近一次续签：

```sh
systemctl list-timers game-web-certbot-renew.timer
journalctl -u game-web-certbot-renew.service --since today --no-pager
```

## 8. 部署验收

服务器本机检查：

```sh
curl -fsS http://127.0.0.1:8081/healthz
curl -fsSI https://106.53.199.187/
curl -fsS https://106.53.199.187/healthz
curl -fsS https://106.53.199.187/api/ice-config
systemctl --no-pager --full status nginx game-web-relay.service coturn game-web-certbot-renew.timer
```

从公网客户端检查 HTTPS、证书 SAN/有效期、WSS 握手、同房聊天与异房隔离。用两台设备/两个网络并分别允许浏览器麦克风后，检查 WebRTC 音频、全体/队伍频道隔离、人数、静音、退出和拒绝麦克风时的错误提示。若没有可授权麦克风的设备，记录该项为待人工验证；单元测试不代表真实媒体链路已经通过。

## 运维

```sh
systemctl restart game-web-relay.service
systemctl reload nginx
systemctl restart coturn
journalctl -u game-web-relay.service -u coturn -f
```

Web 根目录为 `/var/www/game-web`，relay 工作目录为 `/opt/game-web/server`。生产证书在 `/etc/letsencrypt/live/106.53.199.187/`，自动续签由 `game-web-certbot-renew.timer` 管理。
