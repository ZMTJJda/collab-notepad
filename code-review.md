## CoMark-Notepad — Code Review

**项目**: comark-notepad  
**审查日期**: 2026-06-26  
**代码版本**: commit `828860f` (含 markitdown-ts 集成)  
**审查范围**: server.js / public/ / tests/ / Docker 配置  

---

### 总体评价

这是一个架构简洁、安全意识较强的局域网协作记事本。整体设计思路清晰：单文件后端、无框架前端、JSON 持久化，非常适合 LAN 小团队使用场景。~43 个集成测试覆盖了核心功能和安全边界，测试质量不错。

以下按严重程度分级列出发现的问题，并给出改进建议。

---

### 严重问题 (Critical)

**C1 — Docker 镜像缺少 convert-worker.js**

Dockerfile 第 24-25 行只复制了 `server.js` 和 `public/`，遗漏了 `convert-worker.js`。这意味着在 Docker 部署中，所有「转 Markdown」功能会直接报错（Worker 找不到脚本文件）。

修复方式：在 Dockerfile 的 runner stage 加入：

```dockerfile
COPY convert-worker.js ./
```

---

### 高优先级 (High)

**H1 — WebSocket 连接通过 URL query 传递 session token**

`server.js:1291` 中 WebSocket 连接回退到从 query string 读取 token：

```js
const queryToken = url.searchParams.get('token');
```

浏览器 WebSocket API 不支持自定义 header，query string 是常见妥协方案。但 URL 中的 token 会出现在 Nginx/Apache 日志、浏览器历史记录中，存在泄露风险。测试 `identity.test.js:386` 中更是直接将 token 写在 URL 里。

建议：在文档中注明此限制，并在生产部署时确保 HTTPS + 日志脱敏。长期可考虑在 WS 建立连接后通过首条消息传递 token。

**H2 — isAllowedOrigin 在未设置 PUBLIC_ORIGIN 时过于宽松**

`server.js:132-138`：当 `PUBLIC_ORIGIN` 未显式配置时，origin 检查会接受 localhost、127.0.0.1 和当前 LAN IP。这意味着任何同一局域网的设备都可以发起跨域写请求。

对于 LAN 工具这是有意为之，但生产环境必须设置 `PUBLIC_ORIGIN`。建议在启动时如果 `NODE_ENV=production` 且 `PUBLIC_ORIGIN` 为空，打印一条警告日志。

**H3 — CDN 脚本未使用 Subresource Integrity (SRI)**

`index.html:197-198` 加载 `marked` 和 `DOMPurify` 仅通过 jsdelivr CDN，没有 `integrity` 属性。如果 CDN 被入侵，恶意脚本可注入页面。

建议添加 SRI hash：

```html
<script src="..." integrity="sha384-..." crossorigin="anonymous"></script>
```

---

### 中优先级 (Medium)

**M1 — CSP connectSrc 允许任意 ws:/wss: 连接**

`server.js:412` 中 `connectSrc: ["'self'", 'ws:', 'wss:']` 未限制 host。虽然 WebSocket 握手有 origin 检查保护，但 CSP 策略本身过于宽泛。建议收紧为 `connectSrc: ["'self'"]`（同源 ws/wss 默认已包含）。

**M2 — x-forwarded-for 可被伪造以绕过限流**

`server.js:427` 读取 `x-forwarded-for` 用于日志，`express-rate-limit` 默认也按 IP 限流。如果前面没有可信代理，攻击者可通过伪造 X-Forwarded-For 头绕过限流。

建议：如果不在反向代理后面，设置 `app.set('trust proxy', false)` 并配置 rate limiter 的 `keyGenerator` 使用 `req.socket.remoteAddress`。

**M3 — 文本同步为 Last-Write-Wins，无冲突解决**

前端的 deferred text apply 机制（`app.js:675-707`）在 textarea 失焦时直接覆盖为远端最新版本。多人同时编辑同一段落时，一方输入会被静默覆盖。

对于 LAN 记事本场景勉强可接受，但建议在 UI 上给出提示（如「远端有更新」闪烁提示），或长期引入 OT/CRDT。

**M4 — convert worker 无并发上限**

`server.js:1055-1089` 每次转换请求都 spawn 一个新的 Worker，没有并发上限。恶意或高并发请求可能耗尽系统资源。`convertLimiter` 限流为 20 次/15 分钟，缓解了部分风险，但仍建议加一个 in-flight 上限（如最多 3 个同时转换）。

**M5 — 前端 CSS 大量重复**

`style.css` 的 `@media (max-width: 600px)` (852-985 行) 和 `.is-mobile` (987-1085 行) 两套几乎相同的移动端样式，约 100 行重复代码。建议统一使用 `@media` 查询，仅在 iOS Safari 已知不兼容的场景保留 `.is-mobile` 回退。

---

### 低优先级 (Low)

**L1 — server.js 单文件 1414 行，可维护性受限**

目前所有逻辑（auth、store、routes、WebSocket、file handling）都在一个文件中。对于当前规模还能管理，但随着功能增长建议拆分为模块：`store.js`、`auth.js`、`routes/`、`ws.js`。

**L2 — `formatBytes(0)` 返回 "0 undefined"**

`server.js:49-55`：当 `bytes === 0` 时，循环不执行，`idx` 停留在 `-1`，`units[-1]` 为 `undefined`。虽然当前代码中 0 字节的文件不太可能出现，但应加上边界处理。

**L3 — broadcastToPad 遍历全部 client**

`server.js:1331-1343` 每次广播都遍历所有 WebSocket 连接。当前规模下无影响，但可用 `Map<padId, Set<ws>>` 分组以提高效率。

**L4 — renderPadTabs 计算了分组但未使用**

`app.js:131-133` 计算了 `myPads`、`publicPads`、`invitedPads` 三个数组，但实际渲染时 (172-173 行) 用的是 flat list。是死代码，建议删除或实现分组 UI。

**L5 — 项目根目录有 20+ 张 PNG 截图**

这些移动端测试截图应移至 `docs/screenshots/` 或加入 `.gitignore`，避免污染仓库根目录。

**L6 — legacy converter/ 目录残留**

`converter/` 目录是旧版 Python 转换器，虽然 `.venv` 已在 `.gitignore` 中，但目录本身还在。建议清理。

---

### 测试覆盖度评估

当前 43 个测试覆盖了核心场景，质量不错。测试隔离做得好——每个 test 启独立 server + 临时数据目录。

**尚未覆盖的场景：**

- WebSocket 断线重连行为（前端 exponential backoff）
- 文件 TTL 过期清理（`cleanupExpiredFiles`）
- 转换超时（Worker terminate 路径）
- `convertingFiles` 并发锁（同时发起同一文件的转换）
- 密码保护的 pad 的 WebSocket 重连是否携带 padToken
- 端到端协作流程（两个客户端同时编辑的完整交互）

---

### 值得肯定的设计

- **安全意识出色**：HMAC-SHA256 签名 token、timing-safe 比较、scrypt 密码哈希、CSRF origin 校验、7 个细粒度限流器、Helmet CSP、非 root Docker 用户——纵深防御做得扎实。
- **访问控制三层模型**（公开/私有/管理员）设计清晰，权限矩阵在 HTTP 和 WebSocket 层都有一致的检查。
- **测试架构优秀**：每个测试独立进程 + 临时目录，helper 函数封装良好（startServer / createReadyClient / waitForMessage），可读性强。
- **Graceful Shutdown** 处理了 store flush、WebSocket 关闭、timer 清理和超时强杀。
- **文件上传的双重权限检查**（early check + finish-time authoritative check）正确处理了 multipart field 顺序不确定的问题，并有专门的回归测试覆盖。
- **前端简洁有效**：零框架 + CDN Markdown 库，构建步骤为零，维护成本低。

---

### 优先修复建议

| 优先级 | 问题 | 工作量 |
|--------|------|--------|
| 立即修复 | C1 Docker 缺文件 | 1 行 |
| 尽快 | H1 文档注明 WS token 风险 | 小 |
| 尽快 | H3 添加 SRI hash | 小 |
| 近期 | H2 生产环境启动警告 | 小 |
| 近期 | M1 收紧 CSP connectSrc | 1 行 |
| 近期 | M4 convert worker 并发上限 | 中 |
| 计划中 | M3 文本冲突提示 | 中 |
| 计划中 | L1 server.js 模块拆分 | 大 |
