# Changelog

All notable changes to this project are documented in this file.

## [1.0.1] - 2025-07-01

### Architecture — UTL 分层重构

按照 `CoMark-Notepad优化方案utl版.md` 完成全量架构升级，从单文件 `server.js` 迁移至模块化分层架构。

#### 新增目录结构

```
src/
├── server.js          # 入口：DI 组装、HTTP/WS 启动、优雅关闭
├── app.js             # Express 实例、全局中间件挂载
├── config.js          # 环境变量与全局常量
├── utils/             # 无状态纯函数工具层
├── middlewares/        # 全局/路由级中间件
├── auth/              # 身份认证与鉴权
├── db/                # 数据访问层 (Repository 模式)
├── services/          # 核心业务逻辑层
├── ws/                # WebSocket 实时协作
└── routes/            # HTTP 接口层 (薄控制器)
```

#### 核心架构改进

- **全局错误处理**：Service 层统一抛出 `AppError` 体系异常，Route 层 `next(e)` 透传，`errorHandler` 中间件统一映射 HTTP 状态码
- **纯业务层解耦**：Service 方法签名不接收 `req`/`res`，仅接收纯数据参数 (`userId`, `isAdmin`, `padId` 等)，可脱离 HTTP 环境独立测试
- **防抖 + 原子双轨写入**：`store.js` 高频更新用 `save()` 防抖，关键操作用 `flush()` 原子写入，杜绝 JSON 文件损坏
- **Token 撤销闭环**：`revokeToken` 使用 `flush()` 立即持久化，消除 200ms 防抖窗口内的宕机丢失风险
- **循环依赖打破**：提取 `db/revokedTokens.js` 中间模块，消除 `auth/session.js ↔ db/store.js` 循环引用
- **WebSocket padToken 鉴权**：加密 Pad 的 WS 连接必须持有有效 unlock token

### Code Review 修复 (7 项)

#### 路由层净化

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 路由层 `service.db.*` 穿透 | 11 处 | **0 处** |
| 路由层 `broadcast` 直接调用 | 1 处 | **0 处** |
| 路由层 `res.status()` 硬编码 | 25 处 | **2 处** (sendFile 回调例外) |
| `convert.js` 错误字符串映射 | 6 行 | **0 行** (Service 直抛正确 statusCode) |
| `pads.js` password 路由业务逻辑 | ~20 行 | **3 行** (移入 padService) |

#### 具体修复

1. **`requirePadUnlock` 中间件化** — 提取 `security.js` 工厂中间件，消除 7 处 pad lock 重复检查
2. **Service 层新增 getter 方法** — `padService.getPadById()`、`fileService.getFileById()`、`convertService.getFileById()`，路由层不再穿透 db
3. **`padService.updateText()`** — 封装 db 写入 + broadcast，路由层不再直接操作数据
4. **`padService.setPassword()`** — 新增 `unlockToken` 参数，支持 unlock token 或 current password 双认证，自动区分 401/403
5. **`convertService` 错误类型修正** — 新增 `ServiceUnavailableError`(503)、`RequestTimeoutError`(504)，415/422 使用精确 `AppError` 构造
6. **路由层统一 `throw AppError`** — `invitations.js`、`auth.js`、`pads.js`、`files.js` 全部改用 `throw UnauthorizedError/BadRequestError` 替代 `res.status()`
7. **`headersSent` 防御** — `fileService.upload` 和 upload 路由 catch 块添加 `res.headersSent` 保护，防止流式上传中途断开导致进程崩溃

### Docker 修复

- `Dockerfile` 适配 `src/` 目录结构：`COPY src/ ./src/`、`CMD ["node", "src/server.js"]`

### 测试

- 66/66 测试全部通过
- 循环依赖检测 (madge)：仅 `ws/index.js` 误报，实际无循环

---

## [1.0.0] - 2025-06-28

Initial release.

- LAN real-time collaborative notepad with WebSocket sync
- File upload/sharing with MIME type detection
- Pad password protection with unlock token mechanism
- Invitation system for access control
- File-to-Markdown conversion (PDF/DOCX/XLSX/PPTX/images/HTML/CSV)
- Dark/light theme support
- Mobile-responsive UI
- Docker deployment support
