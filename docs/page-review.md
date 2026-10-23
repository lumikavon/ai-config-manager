# 页面功能复核与修复报告

本项目有 3 个页面入口（`config`、`history`、`settings`），由 `src/App.tsx` 的 `Page` 状态切换，另有 1 个非桌面环境的降级界面。本轮（第 2 轮）在 **Windows 原生环境**编译并运行真实应用，按页派生代码检查与界面功能验证 subagent，逐页逐控件核对，再由主 agent 统一修改生产代码与回归测试。

- 第 2 轮结果：**前端 257 项测试（256 通过 / 0 失败 / 1 项已记录的未修复缺陷）**、TypeScript + Vite 生产构建通过、Rust 核心 30 项 + 应用偏好 6 项测试通过、`cargo fmt` 与 `cargo clippy -D warnings` 通过。
- 原生侧：`cargo build -p ai-config-manager` 生成并**实际运行**桌面二进制，三页均与真实 Rust 后端（真实 `~/.config/ai.yml`、真实托盘/自启动查询）连通；真实 IPC 保存与历史读取完成一次往返后已还原用户配置。
- 浏览器侧：真实 Chrome（CDP）以内存 IPC 夹具逐页驱动，覆盖加载/空/失败/冲突/未知等状态，360px 与 1280px 均无横向溢出。

## 范围与执行方式

页面入口与控件清单依据 `README.md`、`docs/core-design.md`、`docs/native-integration.md`、`src-tauri/src/main.rs`、`src-tauri/src/settings.rs`、`crates/core/*` 与 `src/i18n.ts` 核对。项目没有 URL 路由表，页面即前述 `Page` 状态。

| 页面 | 代码检查 subagent | 界面功能验证 subagent | 新增测试文件 |
| --- | --- | --- | --- |
| 配置 config | `job_mvkavkgm_1` | `job_mvkb1mi9_4` | `src/Config.focus.test.tsx`、`src/Config.ui.test.tsx` |
| 历史 history | `job_mvkavkgn_2` | `job_mvkb1mi9_5` | `src/History.focus.test.tsx`、`src/History.ui.test.tsx` |
| 设置 settings | `job_mvkaw1qc_3` | `job_mvkb212f_6` | `src/Settings.focus.test.tsx`、`src/Settings.ui.test.tsx` |

subagent 只读生产代码并各自持有独立测试文件，生产修改由主 agent 统一实施，避免并发编辑 `src/App.tsx`。subagent 报告中标注为 “PENDING FIX” 的断言在修复后已转为常规回归用例。

## 第 2 轮修复清单

### 配置页（config）

| 编号 | 级别 | 触发条件与原行为 | 修复结果 |
| --- | --- | --- | --- |
| CFG-01 | P2 | `type="url"` 的原生约束校验在 `submit` 前拦截，应用自己的本地化提示与 `aria-live` 永不执行，用户只看到 WebView 语言的系统气泡 | 表单改为 `noValidate`，URL 仍由 `save()` 统一校验并给出本地化提示 |
| CFG-02 | P2 | 明确未写入的失败（`VAULT_UNAVAILABLE`、`ENCRYPT_FAILED`、`INVALID_*`、`LOCK_TIMEOUT` 等）在外部件同时变化时会丢弃草稿和新密钥，并称“无法确认提交是否完成” | 仅 `HISTORY_PENDING` / `COMMIT_UNCERTAIN` 视为已提交或未确定；其余错误保留草稿与密钥，只刷新基线版本 |
| CFG-03 | P2 | `CONFLICT` 后“取消更改”恢复冲突前的旧快照，界面看似干净却仍持旧版本，下次保存继续冲突 | 冲突时刷新基线并置为 stale：保存/验证禁用，“取消更改”恢复磁盘真实值并重新可保存 |
| CFG-04 | P2 | API 密钥不像 URL/模型那样去空格；纯空白首次密钥绕过 `t.required` | 密钥同样 `trim()`；空白首次密钥走本地化“必填”提示 |
| CFG-05 | P3 | 所有 `INVALID_*` 归为同一条通用文案 | 新增 `invalid_model` / `invalid_key` 专属文案并按码匹配 |
| CFG-06 | P3 | 仅含零宽字符的模型被当作非空 | 空值判定包含不可见格式字符 |
| CFG-08 | P3 | 读取失败（`config` 为 null）时徽标仍宣称“尚未保存密钥” | 无成功读取时不显示密钥状态徽标 |
| CFG-09 | P3 | 读取失败后表单仍显示旧值 | 失败即清空编辑器并禁用输入 |
| CFG-10 | P3 | `role="alert"` 上显式 `aria-live="polite"` 覆盖断言性播报 | 失败时 `aria-live="assertive"` |
| CFG-11 | P3 | 确认框无 `aria-describedby` | 确认问题文本作为可访问描述 |
| CFG-13 | P3 | `CONFLICT` 按大小写敏感比较 | 所有错误码统一小写比较 |
| CFG-16 | P3 | 首次空配置的 `revision` 为 `""`，与核心的 `"missing"` 不一致 | 统一为 `"missing"` |
| CFGUI-01 | P3 | 确认“取消更改”后触发按钮被禁用，焦点落到 `body` | 焦点移交给仍存在的“保存配置” |
| CFGUI-03 | P3 | 仅依赖 `isTauri()`；IPC 桥缺失时仍渲染外壳并在订阅时抛出 | 同时要求 IPC 桥存在，订阅失败也不影响渲染 |

### 历史页（history）

| 编号 | 级别 | 触发条件与原行为 | 修复结果 |
| --- | --- | --- | --- |
| HIS-01 / HISUI-01 | **P1** | 脱敏只看字段名，粘贴到 `model` 的密钥或 URL 中的凭据原样显示，与“不展示密钥”的页面承诺矛盾 | 增加值级擦除：userinfo、`sk-`/`ghp_`/`AKIA`/`xox*`/JWT/Bearer 及高熵不透明串；敏感字段名匹配扩展到 credential/auth/pass* 等 |
| HIS-03 | P3 | 直接渲染 `base_url`、`false/true`、`[VALUE EXCEEDS LIMIT]` 等协议值 | 字段名、布尔值与超长哨兵全部本地化（原始字段名保留在 `data-field`） |
| HIS-04 | P3 | 连点刷新会并发读取且结果无序 | 增加在途 ref 守卫，一次手势一次读取 |
| HIS-05 | P3 | 历史文件过大时复用配置文案，指向错误的文件 | `TOO_LARGE` 使用历史专用文案 |
| HIS-06 | P3 | 结果区无名称、条目无名称、成功后无播报 | 命名 region + `ul/li` 列表语义 + 条目可访问名 + “已读取 N 条记录。” |
| HIS-07 | P3 | 读取失败被降级为礼貌播报 | 断言性播报 |
| HIS-08 | P3 | 重复 `id` 作为 React key | 组合索引的稳定 key |
| HIS-09 | P3 | 空 diff 条目只显示时间与摘要，读起来像坏卡片（原生运行发现） | 增加“本次提交未改动任何托管字段。”说明 |
| HIS-11 | P3 | 非数组 history 载荷让整棵 React 树卸载（白屏） | 载荷归一化，畸形结构降级为本地化错误 |
| HISUI-03 | P3 | 非敏感字段的 `[EMPTY]` 直接显示为原始哨兵 | 所有字段统一本地化空值 |
| HISUI-05 | **P2** | 摘要与“之前/之后”标签为 10–11px、对比度 2.91:1，低于 WCAG AA | 统一次级文字色板，实测 ≥5:1 |

### 设置页（settings）

| 编号 | 级别 | 触发条件与原行为 | 修复结果 |
| --- | --- | --- | --- |
| SET-01 / SETUI-10 | P2 | 任何保存失败都显示“可能已写入磁盘”，即使后端已证明未替换文件 | 按错误码分类：`TRAY_MENU` = 已保存但托盘未刷新；`SETTINGS_SAVE`/`SETTINGS_LOCK` = 确定失败；未知码才算未确定 |
| SET-02 | P2 | 设置卡片没有“未保存”标识，开关只是草稿而保存按钮恒可用 | 卡片增加“未保存”徽标 |
| SET-03 / SETUI-03 | P2 | 未确定状态下保存被禁用，但唯一解释只在临时状态栏，切换语言或导航即消失 | 卡片内常驻解释，保存不可用期间始终可见 |
| SET-04 | P2 | 已提交的语言变更若托盘菜单重建失败，托盘长期停留在旧语言且无记录 | 后端写入 `TRAY_MENU_STALE` 警告，前端本地化展示 |
| SET-05 | P2 | 无法读取的开机启动状态被渲染成确定的“关闭”开关 | 增加 `data-unknown` 视觉标记与“未知”说明，仍可显式设置 |
| SET-07 | P2 | 更高 `schema_version` 或未知字段被当作默认值，随后一次保存静默降级文件 | 无法解析/版本不支持时拒绝保存并给出可操作警告 |
| SET-08 | P3 | 自启动修改与核对读取双双失败时，未知状态未进入警告横幅 | 未知状态记录为 `AUTOSTART_UNKNOWN` 警告 |
| SET-09 | P3 | 常驻系统警告使用断言性 `role="alert"`，且持久化不确定文案重复播报 | 横幅保留 alert（真实系统问题），状态行仅在失败时断言性；去重后单次播报 |
| SET-13 | P3 | 偏好文件无大小上限 | 512 KiB 上限，超限按不可读处理 |
| SETUI-02 | P2 | 11px 辅助文字与元数据标签对比度 2.91–3.14:1 | 色板 token 化，全部 ≥4.5:1（实测 5.0–5.9:1） |
| SETUI-04 | P3 | 保存成功提示在一段新的编辑后仍显示；隐藏失败提示在下一次成功后仍显示 | 编辑即清除成功提示；隐藏成功即清除错误提示 |
| SETUI-05 | P3 | 读取设置期间状态区无任何播报 | 共享 live region 与页面级 `role="status"` 同时播报 |
| SETUI-07 | P3 | 设置卡片与元数据卡片是无名 section | 两者均有可访问名称 |
| SETUI-08 | P3 | `window_hide` 的 `TRAY_UNAVAILABLE` 显示通用失败文案 | 使用托盘专用文案 |

### 窗口框架（全部页面共用）

| 编号 | 级别 | 触发条件与原行为 | 修复结果 |
| --- | --- | --- | --- |
| WIN-01 | **P1** | `src-tauri/Cargo.toml` 缺少 `custom-protocol` 特性；tauri 的构建脚本据此判定 dev/prod，因此 `cargo build --release` 生成的“发布”二进制仍然加载 `http://localhost:1420`（dev 服务器）。没有 dev 服务器时发布版只会显示连接失败页 | 增加 `custom-protocol = ["tauri/custom-protocol"]` 特性并记录用法；`npm run tauri -- build` 会自动启用，直接 `cargo build --release` 需显式 `--features custom-protocol`。修复后发布二进制加载内嵌资源（`http://tauri.localhost/`），无需 dev 服务器 |
| WIN-02 | P3 | 自绘标题栏用 `listen("tauri://resize")` 监听尺寸变化，而窗口事件是按窗口投递的，全局监听收不到：用系统按钮/贴边最大化后“最大化/还原”图标不更新 | 改用窗口级 `getCurrentWindow().onResized`（懒加载，缺少窗口桥接时静默跳过）；已用系统级还原验证图标随之更新 |
| WIN-03 | P3 | 无边框窗口没有关闭入口的兜底 | 关闭按钮走 `window.close()`，仍由 `close_to_tray` 决定隐藏或退出；草稿未保存时先弹确认 |

标题栏控件（最小化 / 最大化·还原 / 关闭 / 拖动区）在真实窗口中逐项验证：最大化后 `IsZoomed=True`、系统还原后按钮文案回到“最大化”、最小化后主窗口 `IsIconic=True`、关闭后进程存活且窗口隐藏（`close_to_tray` 默认开启）。

### 共享 / Rust 核心

| 编号 | 级别 | 问题 | 修复结果 |
| --- | --- | --- | --- |
| CORE-01 | **P1** | Windows 上锁争用返回 `ERROR_LOCK_VIOLATION(33)`，`io::ErrorKind` 不是 `WouldBlock`，5 秒有界等待从不生效：并发保存立即 `IO` 失败（`lock_timeout_is_bounded` 在 Windows 上真实失败） | 按平台原始错误码识别争用，窗口内重试后返回 `LOCK_TIMEOUT` |
| CORE-02 | P2 | 替换前失败留下的 `.pending.json` 若期间被外部改写，`recover()` 返回 `HISTORY_CORRUPT`，保存彻底死锁且提示“恢复历史文件” | 配置未被本事务替换时丢弃过期日志；历史字节仅在确认替换后写入，不会被误改 |
| CORE-03 | P3 | 过期版本 + 历史不可读时报 `HISTORY_CORRUPT` 而非 `CONFLICT` | 版本校验提前到历史读取之前（`recover()` 仍需最先执行） |
| CORE-04 | P3 | 语义摘要路径中的明文字典树在释放前未擦除 | 摘要生成后递归擦除 JSON 字符串叶并显式释放 |
| CORE-05 | P3 | `manual_div_ceil` 触发 `clippy -D warnings` | 改用 `div_ceil` |
| APP-01 | P2 | 偏好文件无法解析时仍允许保存，静默降级为 v1 | 拒绝覆盖并提示修复/移除 |
| APP-02 | P3 | 偏好读取无上限 | 512 KiB 上限 |

## 未修复项（已记录）

| 编号 | 级别 | 说明 | 原因 |
| --- | --- | --- | --- |
| CFG-17 | P3 | 已处于明文模式的配置再次保存新密钥时不再重复明文确认 | 明文是用户已确认并持续有效的选择；每次保存都弹确认会破坏可用性 |
| SET-06 | P3 | 托盘不可用的会话中，持久化为 `true` 的静默/托盘开关显示为勾选但禁用，用户无法在本次会话清除 | 直接改为未勾选会失去“已存偏好”的事实；需要产品决策（移除或提供显式清除） |
| HIS-02 部分 | P3 | 敏感字段名匹配已扩展，但仅凭名字无法完全判定某值是否为凭据 | 值级擦除基于模式，无法对任意文本做无损判别 |

## 验证证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 前端行为回归 | `npm test -- --run` | 10 个文件、257 项：256 通过、0 失败、1 项已记录跳过 |
| 类型 + 生产构建 | `npm run build` | exit 0（tsc -b + vite build） |
| Rust 核心 + CLI | `cargo test --locked` | 4 + 1 + 25 通过 |
| 桌面偏好 | `cargo test --locked -p ai-config-manager` | 6 通过 |
| 格式 / 静态检查 | `cargo fmt --all -- --check`、`cargo clippy -D warnings` | 通过 |
| 原生构建（dev） | `cargo build --locked -p ai-config-manager` | exit 0（223 crates，加载 devUrl） |
| 原生构建（发布） | `cargo build --locked --release -p ai-config-manager --features custom-protocol` | exit 0；二进制加载内嵌资源 `http://tauri.localhost/` |
| 原生运行（dev） | `target/debug/ai-config-manager.exe` + WebView2 CDP | 三页与真实后端连通；标题栏最小化/最大化/还原/关闭逐项验证 |
| 原生运行（发布） | `target/release/ai-config-manager.exe`（无 dev 服务器） | 内嵌资源渲染成功，标题栏与真实配置读取正常 |
| 真实浏览器 | `.review/harness/drive.mjs`（独立 headless Chrome 1280/360） | 三页 + 空/失败/冲突/未知状态，`overflow = 0`，无未捕获异常 |

截图（`.review/after/`）：`native-config-final.png`、`native-history.png`、`native-window-settings.png`、`history-emptydiff.png`、`history-credential.png`、`config-conflict.png`、`settings-unknown.png`、`settings-save-failed.png`、`config-360.png`、`history-360.png`、`settings-360.png`、`fallback-browser.png`。

## 验证边界

- 浏览器验证使用 `.review/harness/` 中的内存 IPC 夹具，不被生产代码导入（`dist` 中检索不到夹具字符串），不读写用户配置、不访问系统凭据存储、不修改开机启动项。
- 原生验证确实运行了桌面二进制并使用真实 Rust 后端与真实配置：一次保存往返与历史读取后已按字节还原 `~/.config/ai.yml` 并删除 `ai.yml.history.json`、`ai.yml.lock`、`ai.yml.pending.json`。验证过程中意外触发过一次“加密保存”，系统凭据存储因此新增了 `ai-config-manager` / `config-encryption-v1` 条目；配置文件已还原为明文，该条目未被删除（不主动删除用户凭据），也不再被引用。
- 托盘菜单的显示/隐藏/退出、开机启动注册的 OS 写入、安装包与签名仍属 [原生验收清单](native-integration.md) 范围；本轮只验证了真实 `is_enabled()` 查询与托盘可用性判定，未通过系统 UI 点击托盘图标。
- 未生成安装包；未在 macOS / Linux 上运行。
