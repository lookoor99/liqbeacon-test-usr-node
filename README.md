# Liqbeacon Webhook 测试接收端

按控制台「快速接入」Node 示例改写的 TypeScript 版本，扮演一个真实用户的接收端，部署在独立的 Ubuntu 服务器上，
用来验证平台的 webhook 能否正常送达、签名能否校验通过，以及顺序、重复、缺口、回滚这几项投递语义是否符合预期。

| 文件 | 作用 |
| --- | --- |
| `src/server.ts` | Express 接收端：`express.raw` 取原始字节，`verifyEvent` 校验签名，处理测试事件，按需注入故障 |
| `src/handlers.ts` | 按事件类型打印入账 / 出账 / 回滚（对应 `handlers.mjs`） |
| `src/sequence.ts` | `SequenceTracker` 两步用法（先 check、成功后 commit）、缺口检测、自动请求重放、首次运行加载快照（对应 `sequence.mjs`） |
| `src/recorder.ts` | 每次请求（包括签名失败的）都追加写入 `data/received.ndjson`，`GET /status` 提供汇总 |
| `scripts/send-test.ts` | 本地自测：用同一个 `WEBHOOK_SECRET` 按平台的算法签名，发送 9 个用例 |
| `deploy/` | systemd 服务文件、nginx 站点配置 |
| `vendor/` | 离线 SDK 包 `liqbeacon-sdk-1.0.0.tgz`，服务器无需访问 npm 上的 `@liqbeacon/sdk` |

## 一、前提

平台生产配置为 `DELIVERY_ALLOW_HTTP=false`、`DELIVERY_BLOCK_PRIVATE_ADDRESSES=true`，所以 webhook 地址必须：

- 使用 **https**；
- 域名解析到**公网 IP**（内网地址、`localhost`、`*.internal` 都会被拒绝）；
- 端口不在封禁列表中（22、25、3306、5432、6379 等）。用 443 即可。

需要准备：一台有公网 IP 的 Ubuntu 22.04 / 24.04 服务器、一个指向它的域名（下文用 `hook.example.com`），
并在安全组 / 防火墙中放行 80 和 443。

## 二、部署到 Ubuntu

```bash
# 1. Node.js 20（18 以上都可以）、nginx、certbot
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx

# 2. 上传项目（在开发机上执行；node_modules、dist、data 不要传）
scp -r webhook-test/{package.json,package-lock.json,.npmrc,tsconfig.json,.env.example,src,scripts,vendor,deploy,README.md} \
    user@hook.example.com:/tmp/webhook-test/

# 3. 在服务器上安装
sudo useradd --system --home /opt/webhook-test --shell /usr/sbin/nologin webhook
sudo mkdir -p /opt/webhook-test && sudo cp -r /tmp/webhook-test/. /opt/webhook-test/
cd /opt/webhook-test
sudo npm ci                       # SDK 从 vendor/ 安装，其余依赖来自 npm
sudo npm run build
sudo cp .env.example .env && sudo nano .env      # 至少填写 WEBHOOK_SECRET
sudo mkdir -p data && sudo chown -R webhook:webhook /opt/webhook-test
sudo chmod 600 .env

# 4. 启动服务
sudo cp deploy/webhook-test.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now webhook-test
journalctl -u webhook-test -f

# 5. nginx + HTTPS（先把 deploy/nginx.conf 里的 hook.example.com 改成你的域名）
sudo cp deploy/nginx.conf /etc/nginx/sites-available/webhook-test
sudo ln -s /etc/nginx/sites-available/webhook-test /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d hook.example.com
```

`.npmrc` 和 `package-lock.json` 都指向公网 `registry.npmjs.org`。在公司内网安装时，执行 `npm ci --registry=<内网镜像>` 即可，不用改文件。
如果服务器不能访问 npm，可以在一台同为 Linux x64 的机器上执行 `npm ci && npm run build`，再把整个目录（包括 `node_modules`）打包上传。
本项目没有原生模块，跨机器拷贝 `node_modules` 是安全的。

## 三、配置（`.env`）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `WEBHOOK_SECRET` | 是 | 订阅的签名密钥 `whsec_...`，创建订阅或轮换密钥时只显示一次 |
| `WEBHOOK_SECRET_PREVIOUS` | 否 | 轮换后 24 小时内的旧密钥 |
| `LIQBEACON_API_URL`、`LIQBEACON_API_KEY` | 否 | 配置后，发现缺口时自动调用 `POST /v1/subscriptions/{id}/replay`；不配置则只记录缺口 |
| `LIQBEACON_SUBSCRIPTION_ID` | 否 | 首次运行时调用快照接口，从 `next_seq` 开始接收事件，并打印平台侧的序号范围 |
| `HOST`、`PORT`、`WEBHOOK_PATH` | 否 | 默认 `127.0.0.1:3000/webhooks/cardano`，由 nginx 反向代理 |
| `DATA_DIR` | 否 | `cursors.json` 和 `received.ndjson` 的存放目录，默认 `./data` |
| `STATUS_TOKEN` | 否 | 设置后，访问 `GET /status` 需要带 `Authorization: Bearer <token>` |
| `SIMULATE_FAILURE_RATE` | 否 | 0～1，按比例对真实事件返回 500，用来观察重试和保序 |
| `SIMULATE_DELAY_MS` | 否 | 每个请求延迟多少毫秒再响应，用来观察超时（平台默认 10 秒） |

修改 `.env` 后执行 `sudo systemctl restart webhook-test`。

## 四、测试步骤

### 1. 自测接收端（不经过平台）

```bash
cd /opt/webhook-test
npm run send-test                                              # 直连 127.0.0.1:3000
npm run send-test -- https://hook.example.com/webhooks/cardano # 经过 nginx + TLS 全链路
```

预期 9/9 通过：测试事件 200；错误密钥、过期时间戳、篡改正文各返回 400；seq 1、重复的 seq 1、seq 2、
seq 4（日志里会出现 `missed seq 3`）、seq 3 回滚都返回 200。自测事件使用 `sub_selftest_...` 订阅 ID，
不会影响真实订阅的游标，也不会触发重放请求。自测前请把 `SIMULATE_FAILURE_RATE` 设为 0。

### 2. 在控制台创建订阅

webhook 地址填 `https://hook.example.com/webhooks/cardano`，把显示的 `whsec_...` 填入 `.env` 的 `WEBHOOK_SECRET`，然后重启服务。

### 3. 发送测试事件

在订阅详情页点击「发送测试事件」。控制台应显示 2xx，日志中出现：

```
[test]     evt_test_... for sub_...: signature ok
```

如果出现 `[rejected] ... signature mismatch`，说明密钥填错了；如果服务端日志里什么都没有，请检查 DNS、证书、防火墙和 nginx。

### 4. 真实链上事件

向订阅监听的地址转一笔 ADA。达到 `min_confirmations` 后应依次收到 `utxo.produced`，
花费该输出后收到 `utxo.spent`。核对以下几点：

| 检查项 | 怎么看 |
| --- | --- |
| 送达 | `journalctl -u webhook-test` 中有 `[produced]` / `[spent]` |
| 序号连续 | `GET /status` 的 `gaps` 为空，`cursors` 中该订阅的值等于平台的最新序号 |
| 头与正文一致 | 日志中没有 `[mismatch]`；`received.ndjson` 里的 `headers` 与 `body` 可以逐条对照 |
| 重复处理 | 重复投递的事件在记录中标为 `duplicate`，并且返回 200 |

### 5. 重试与保序

在 `.env` 中设置 `SIMULATE_FAILURE_RATE=0.5` 后重启，再产生几笔交易。预期结果：

- 被拒绝的事件按退避时间重试（首次约 2 秒，之后逐次翻倍）；
- 同一订阅内，后面的事件不会越过失败的那一个，`received.ndjson` 中处理成功的 `seq` 严格递增；
- 连续失败 12 次（`DELIVERY_MAX_ATTEMPTS`）后订阅进入暂停状态，并发送邮件。恢复订阅后从断点继续投递。

把 `SIMULATE_DELAY_MS` 设为 `12000` 可以观察超时：平台在 10 秒后放弃请求并记为失败，但接收端延迟结束后仍会处理该事件。
由于每次重试都会再延迟 12 秒，所有尝试都会超时，最终订阅被暂停。`received.ndjson` 中该事件第一次记为 `processed`，
之后都是 `duplicate`。这说明了为什么必须按 `event.id` 去重。改回 `0` 并恢复订阅后，下一次重试成功，队列继续投递。

### 6. 重放

```bash
curl -X POST https://<api>/v1/subscriptions/<sub_id>/replay \
     -H "X-Api-Key: sk_live_..." -H "Content-Type: application/json" \
     -d '{"from_seq": 1}'
```

重放的事件 id 和 seq 都保持不变，接收端应把它们全部标为 `duplicate`。如果想让接收端把重放的事件当作新事件重新处理，
可以先停止服务，把 `data/cursors.json` 中该订阅的值改小（例如改为 `0`），启动后再重放。

## 五、查看结果

```bash
curl -s -H "Authorization: Bearer $STATUS_TOKEN" https://hook.example.com/status | jq
tail -f /opt/webhook-test/data/received.ndjson | jq -c '{received_at, outcome, status, event_type, seq}'
```

`received.ndjson` 每行一条请求记录，包括原始正文和所有 `X-Cardano-*` 头，测试期间不会轮转。长期运行时请自行清理。

## 六、注意事项

- **按 `event.id` 去重的记录目前只保存在内存里**（`handlers.ts` 中的 `applied`），重启后会清空。
  游标（`cursors.json`）是持久化的，所以重启后重复投递的事件仍能被 `SequenceTracker` 识别；
  真实业务中应把去重记录和业务数据写在同一个事务里。
- 签名的时间容差为 300 秒，服务器时钟必须准确（Ubuntu 默认启用 `systemd-timesyncd`）。
- 不要在 nginx 和应用之间加入任何会改写请求体的中间件，签名覆盖的是原始字节。
