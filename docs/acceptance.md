# 验收记录与发布门槛

验证日期：2026-10-23。执行环境：**Windows 11 x64 桌面**（MSVC 工具链、WebView2 运行时 155.0.4283.62）、Node.js 24.12.0、Rust 1.92.0。

## 本轮实际执行

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 依赖安装状态 | `npm ci`（依赖已锁定并安装） | 通过 |
| 前端行为回归 | `npm test -- --run` | 10 个文件 / 257 项：256 通过、0 失败、1 项已记录的未修复缺陷 |
| 类型 + 生产构建 | `npm run build` | exit 0（`tsc -b` + `vite build`） |
| Rust 核心 + CLI | `cargo test --locked` | 4 + 1 + 25 通过 |
| 桌面偏好模块 | `cargo test --locked -p ai-config-manager` | 6 通过 |
| 格式 / 静态检查 | `cargo fmt --all -- --check`、`cargo clippy --locked -p ai-config-core -p ai-config-cli --all-targets -- -D warnings` | 通过（无告警） |
| 原生构建（dev） | `cargo build --locked -p ai-config-manager` | exit 0（223 个 crate） |
| 原生构建（发布） | `cargo build --locked --release -p ai-config-manager --features custom-protocol` | exit 0（2m07s，LTO + strip） |
| 原生运行 | `target/debug/ai-config-manager.exe` | 窗口启动，三页均与真实后端连通 |

### 原生运行验证内容

通过 WebView2 远程调试端口（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`）驱动真实窗口，且 `window.__TAURI_INTERNALS__` 为真实桥接（无任何夹具）：

- **配置页**：真实 `config_read` 读取 `~/.config/ai.yml`（存在、明文密钥、`key_present=true`），密钥框为空，徽标为“明文存储”。
- **真实保存往返**：点击“保存配置”→ `config_save` 写入（含事务注释）→ 状态显示“配置已安全提交。”→ `ai.yml.history.json` 生成 1 条记录 → 历史页显示该记录、来源徽标与完整 64 位摘要。
- **历史页**：真实 `history_list` 渲染；空 diff 条目显示“本次提交未改动任何托管字段。”。
- **设置页**：真实 `settings_read` 返回版本 0.1.0、平台 `windows`、托盘能力“可用”，自启动状态来自真实 `is_enabled()` 查询（`autostart_known=true`，无警告）。
- **窗口框架**：自绘标题栏（品牌 + 最小化 / 最大化·还原 / 关闭 / 拖动区）在真实窗口中逐项验证——最大化后 `IsZoomed=True`，系统级还原后按钮文案回到“最大化”，最小化后主窗口 `IsIconic=True`，关闭后进程存活且窗口隐藏（`close_to_tray` 默认开启）。
- **发布二进制**：`target/release/ai-config-manager.exe` 在**未运行 dev 服务器**时加载内嵌资源 `http://tauri.localhost/` 并正常渲染（修复了缺少 `custom-protocol` 特性导致发布版指向 dev URL 的问题）。
- **还原**：验证后 `ai.yml` 已按字节还原（`revision` 与备份一致），并删除本轮产生的 `ai.yml.history.json`、`ai.yml.lock`、`ai.yml.pending.json`；未修改开机启动注册。

窗口级证据见 `.review/after/native-config-final.png`、`native-history.png`、`native-window-settings.png`（后者为 `PrintWindow` 抓取的含标题栏窗口）。

### 真实浏览器验证内容

`.review/harness/drive.mjs` 启动独立 headless Chrome，加载带内存 IPC 夹具的页面（夹具不被生产代码导入，`dist` 中检索不到夹具字符串）：

- 三个页面 × 360px / 1280px：`scrollWidth === clientWidth`，无横向溢出。
- 配置：已保存 / 首次空配置 / 冲突（保存被拒后保存禁用、取消可用、错误断言性播报）。
- 历史：单条 / 空 / 读取失败 / 凭据样例 / 空 diff；凭据样例中 `sk-…` 与 URL userinfo 均被擦除，页面文本不含凭据原值。
- 设置：正常 / 托盘不可用 / 自启动未知（`data-unknown="true"`）/ 保存确定失败（“原有设置仍然生效”）/ 托盘菜单刷新失败（“设置已保存，但托盘菜单未能刷新”）。
- 纯浏览器（无 Tauri）：显示“请在桌面应用中打开”，无未捕获异常。

## 本轮修复中与验收相关的行为变更

- Windows 锁争用曾返回 `IO` 而非 `LOCK_TIMEOUT`（`io::ErrorKind` 不映射 `ERROR_LOCK_VIOLATION`）：已修复，`lock_timeout_is_bounded` 在 Windows 上通过。
- 替换前失败遗留的 `.pending.json` 曾在外部改写配置后造成 `HISTORY_CORRUPT` 死锁：已修复。
- 偏好文件无法解析时曾允许保存并静默降级 schema：现在拒绝覆盖。
- 详细清单见 [页面功能复核与修复报告](page-review.md)。

## 工具链说明

- `rust-toolchain.toml` 固定 1.90.0，但本机未安装该版本，且 rustup 访问已配置的 USTC 镜像时 TLS 握手失败（`unexpected EOF during handshake`）。本轮使用已安装的 **1.92.0** 执行，满足 `rust-version = "1.90"` 的最低要求；未修改 `rust-toolchain.toml` 或全局镜像设置。安装 1.90.0 后应重跑同一组命令确认。
- `npm ci` 需要网络访问 npm registry；依赖已安装且 `package-lock.json` 未变更。

## 未验证，发布前必须完成

以下是本轮**没有**通过真实系统 UI 或安装包验证的项目，不得标记为已通过：

- 托盘菜单的显示 / 隐藏 / 打开设置 / 退出（只验证了托盘创建成功、能力判定为可用以及菜单刷新失败的错误路径；未在系统通知区域实际点击）。
- 开机启动注册的 OS 写入与重启后行为（只验证了真实 `is_enabled()` 查询）。
- 静默启动 `--silent`、关闭到托盘、单实例唤起在真实桌面的交互体验。
- 系统凭据存储的首次授权提示、锁定、重启后读取；本轮未做加密保存的端到端验收（验证中意外产生过一次加密写入，已还原配置；系统凭据存储因此存在一条 `ai-config-manager` / `config-encryption-v1` 条目，未被删除）。
- 安装包的构建、安装、升级、卸载、签名与公证；`npm run tauri -- build` 未执行。
- macOS 与 Linux 的原生运行、WebKitGTK/GTK 依赖、LaunchAgent 与 autostart 桌面项。
- 键盘全流程、高 DPI、多显示器与真实屏幕阅读器；仅验证了 DOM 语义、焦点流转（jsdom）与对比度（计算值）。
- 视觉回归：截图用于人工确认，未做像素基线比较。

## 可复现命令

```sh
npm ci
npm test -- --run
npm run build
cargo test --locked
cargo test --locked -p ai-config-manager
cargo clippy --locked -p ai-config-core -p ai-config-cli --all-targets -- -D warnings
cargo fmt --all -- --check
cargo build --locked -p ai-config-manager
cargo build --locked --release -p ai-config-manager --features custom-protocol
# 原生窗口 + 远程调试（仅本机验证用）：
#   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 target/debug/ai-config-manager.exe
```

## 已知边界

- YAML 注释/布局不会保留；保存加入非敏感事务注释。受支持的未知字段值保留。
- 系统安全存储之外没有不安全 fallback；vault 不可用时用户须解决原因或显式选择明文模式。
- 默认路径及其祖先不能是符号链接；不合作的外部写入仍不受本工具锁协议约束。
- Linux 只在启动时检测托盘宿主，不持续监测后续宿主消失。
- 历史摘要为全配置的敏感相等性指纹，不是签名或可信审计链。
- 应用偏好不支持运行期间由外部编辑器修改并热加载；文件不可解析时会拒绝保存，需人工修复或移除。
