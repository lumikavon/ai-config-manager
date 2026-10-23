# AI Config Manager

Tauri 2 桌面配置工具，默认中文，支持英文。仅在本机管理 `~/.config/ai.yml` 的 OpenAI 配置，提供加密保存、最近十次变更、托盘、自启动、静默启动以及共享核心的 CLI / Skill。

## 环境与安装

- Rust **1.90.0**，由 `rust-toolchain.toml` 固定；Node.js **22 或 24 LTS** 与 npm。
- Windows 10/11：Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”、Windows SDK、Microsoft Edge WebView2 Runtime。使用原生 MSVC Rust 工具链构建，不需要管理员权限运行应用。
- macOS：Xcode Command Line Tools，系统 Keychain。打包、签名与公证需要开发者自己的 Apple 身份。
- Linux：GTK 3、WebKitGTK 4.1、AppIndicator、Secret Service 会话服务。Debian/Ubuntu 可安装 `build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`。加密需要已解锁的 GNOME Keyring/KWallet Secret Service，纯 headless 系统不能视为原生验收环境。

在源码根目录执行：

```sh
npm ci
npm run tauri -- dev
```

首次打开配置页，录入 Base URL、模型和 API Key，保持“加密保存”开启并保存。密钥框在读取已有配置后永远为空，空白表示保留原密钥，而非清空。需要替换时输入新密钥。系统安全存储不可用时会失败，不会退回明文。

### 测试、构建与打包

```sh
npm test -- --run
npm run build
cargo test --locked
cargo fmt --all -- --check
npm run tauri -- build   # 自动启用 custom-protocol（内嵌前端）
# 直接调用 cargo 时：cargo build --locked --release -p ai-config-manager --features custom-protocol
# 缺少 custom-protocol 的 release 构建会以 dev 模式加载 build.devUrl，产物不可分发
cargo build --locked --release -p ai-config-cli
```

`cargo test` 默认只运行核心与 CLI，不要求 GUI 库；桌面原生测试可用 `cargo test --locked -p ai-config-manager`，需要上面的原生依赖。`scripts/verify.sh` / `scripts/verify.ps1` 顺序执行基础验证。安装包位于 `target/release/bundle`，CLI 为 `target/release/ai-config`（Windows 为 `.exe`）。Windows 安装包在 Windows 原生环境生成。不要把跨平台 `cargo check` 当成安装或桌面运行通过。

推送 `v*` 标签会触发 `.github/workflows/release.yml`：先执行前端与 Rust 验证，再在 Windows、macOS（Apple silicon）和 Linux 上构建安装包，并自动发布为 GitHub Release。构建产物未签名。

仓库提交 `Cargo.lock` 与 `package-lock.json`，构建使用锁文件。CI 配置提供三个 OS 的原生编译检查，但配置存在不代表 CI 已执行。实际验证记录见 [验收记录](docs/acceptance.md)。签名证书、API Key 和开发者身份均不随源码提供；未签名的安装包可能被系统提示来源未验证。

## 路径与配置格式

所有系统均使用当前用户 home 下 `.config/ai.yml`，Windows 例如 `C:\Users\Alice\.config\ai.yml`。不是 `%APPDATA%` 中的 AI 配置副本。桌面应用偏好设置则使用 Tauri 的应用配置目录。

```yaml
ai:
  openai:
    base_url: https://api.openai.com/v1
    api_key: ENC(v1:BASE64_ENVELOPE)
    model: your-model-id
  another_provider:
    enabled: false
other_settings:
  labels: [internal, workstation]
```

示例的 `BASE64_ENVELOPE` 仅表示格式，不能当作真实加密值。已有明文 API Key 可读取且不会回传前端；再次保存时可迁移为加密。保存保留未修改字段的 YAML **值语义**，不保留注释、缩进、锚点表现形式或键的原始排列。拒绝重复键、多文档、复杂非字符串映射键、自定义标签及非有限数值等歧义输入；格式错误时不覆盖原文件。

Base URL 限定 HTTP(S)，必须有主机，不允许用户名、密码、查询参数或 fragment。模型和密钥不得为空或含控制字符。URL 不做网络可达性检查；离线校验也不证明上游账号、模型权限或计费额度有效。HTTP 会明文传输网络数据，只有信任本机代理时才应使用；该工具自身不发起模型网络请求。

## 加密、解密与安全边界

使用 RustCrypto AES-256-GCM，随机 256 位数据密钥来自操作系统随机源，并保存在操作系统凭据存储中。每次加密产生新的 96 位 nonce，固定附加认证数据为 UTF-8 `ai-config-manager:api-key:v1`。

`ENC(v1:BASE64)` 的 BASE64 使用标准 alphabet 与 padding，解码字节为 `12 字节 nonce || AES-GCM ciphertext || 16 字节认证标签`。整个字符串放在 `ai.openai.api_key`。没有自定义密码学，也没有源码内固定密钥。

读取时先识别 ENC 版本，再向安全存储读取原密钥，验证 GCM 标签后仅在 Rust 内存中消费明文。缺失密钥、错误格式、未知版本、锁定 vault 或认证失败都会明确失败，不新建替代解密密钥、不降级、不把密钥返回前端。首次加密保存才可以创建新密钥。配置中的保存值和凭据存储中的数据密钥必须同时可用；单独复制 YAML 到另一台机器通常无法解密。

平台使用 keyring 3.6.3：Windows Credential Manager、macOS Keychain、Linux Secret Service。确切凭据条目命名及一致性机制见 [核心设计](docs/core-design.md)。所有密钥管理动作都发生在当前用户身份下；应用不自动提升权限。开发测试使用合成密钥和内存 vault，不注册真实凭据。

密钥输入默认密码显示；不会打印到日志、命令参数、历史或异常中。Rust 秘密类型使用脱敏 Debug 并清零自身缓冲区；语言运行时、序列化及系统组件可能产生短期副本，因此不宣称抵御内存取证。同一系统用户、管理员或已入侵进程仍可能读取本机凭据或截取输入。不要将自己的密钥填入截图、Issue 或聊天。

默认加密。显式选择明文保存需要界面确认，文件仍按私密权限写入。Unix 新文件为 0600；Windows 私密文件使用当前用户受保护 DACL。不会批量改动父目录及其他配置的权限。文件权限不是备份加密的替代品。不要通过共享目录同步明文配置。

## 原子保存、并发与变更历史

前端读取的 `revision` 是当前文件原始字节的 SHA-256；首次不存在为 `missing`。保存要求版本匹配，并以文件锁串行化本工具的多个进程。临时文件写入、刷新，再在同一目录替换目标。外部程序若不遵守相同锁协议，仍可能在最终检查后写入；本工具不能对不合作程序提供文件系统级 compare-and-swap。

历史记录包含 `id`、RFC3339 UTC `timestamp`、`diff`、`sha256` 和 `source`。最新在前，最多十条。仅记录托管字段差异；密钥变更只显示 `[EMPTY]` / `[REDACTED]`。重新输入同一密钥仍作为一次替换操作记录，不能从历史还原旧密钥。

配置旁的私密 `.history.json` 保存历史，`.pending.json` 是不含密钥的提交意图，`.lock` 用于跨进程锁。提交先写意图，再替换 YAML，最后根据原始文件版本完成历史。崩溃后根据配置的实际版本对账，不伪造回滚。每次保存添加一个不含秘密的随机事务注释，保证即使明文内容未改变，原始字节版本也能区别提交前后；语义 SHA-256 不受影响。恢复同时校验历史前态摘要，过期旁车文件不能覆盖更新的历史。`HISTORY_PENDING` 表示配置已经提交但历史待恢复，应重新读取并查询历史，不能盲目重复保存。格式损坏的历史不会阻止读取当前配置，但会阻止下一次保存，避免丢弃旧证据。请先备份相关文件，再按错误恢复说明处理。

### SHA-256 的对象

摘要针对**完整配置的语义内容，包括在后端解密后的 API Key**，不是随机 ENC 密文，也不是脱敏视图。先把 `ai.openai.api_key` 替换为内存中的明文，递归转换为 JSON：映射键按字典序，数组保持顺序，字符串/布尔/null/有限数字按 JSON 编码，无额外空白；对 UTF-8 字节计算小写十六进制 SHA-256。注释、YAML 格式及加密 nonce 不影响摘要；其他字段的语义变化会影响摘要。不进行 URL 大小写等业务归一化。详情与具体数字规范见核心设计。

摘要不是签名，也不是第三方可信审计证明。由于包含密钥，持有历史并已知其他内容的人可猜测低熵密钥，因此必须使用高熵 API Key 并保护历史文件。加密与明文存储模式不改变语义摘要。

## 托盘、自启动与静默

关闭窗口默认隐藏到托盘。托盘菜单可显示、隐藏、打开设置、真正退出。设置中可以关闭“关闭到托盘”。`--silent` 或持久化的静默设置会在启动后不显示主窗口；开机启动注册携带 `--silent`。如果托盘不可用，应用必须显示窗口而不静默失联。

自启动状态向操作系统实际查询，不以普通 JSON 的布尔值冒充注册成功。更改失败或查询未知会显示错误。Windows 使用用户启动注册，macOS 使用 LaunchAgent，Linux 使用桌面会话 autostart；具体后台限制见 [桌面集成](docs/native-integration.md)。同一应用重复启动会唤起已有实例。

## CLI 与 Skill

构建 CLI 后将二进制所在目录加入 PATH。将 `skill/ai-config` 复制到使用者的 Skill 目录（例如 `~/.codex/skills/ai-config`），无需修改指令内容。它不自动安装、不保存新凭据，也不访问外部模型服务。

```sh
ai-config read
ai-config check
ai-config history
ai-config read --config /path/to/ai.yml
```

CLI 只输出单个 JSON 结果，成功退出码 0，失败 1；`--help` 输出帮助文本。read 返回脱敏元数据，check 验证并在内存解密，history 返回脱敏记录。没有导出明文密钥选项。读操作可能创建私密锁文件；history 会完成已经提交的待恢复历史，因此不是字节意义上的零写入诊断。

可信 Rust 工具直接依赖 `crates/core` 并使用 `Store::with_config`。回调获得同一快照的 Base URL、模型和 `with_secret` 访问器；不得将访问器中的秘密打印、序列化或交给不可信子进程。实际发送授权头需要调用工具自己获得对指定服务的授权，该库不自动发送。

## 结构

```
src/                     React UI 与集中式文案
src-tauri/               桌面命令、窗口、托盘与应用设置
crates/core/             配置、加密、历史、原子文件与平台权限
crates/cli/              无凭据输出的 CLI
skill/ai-config/         可复用 Skill
scripts/                 验证及可复现源码打包
.github/workflows/       构建验证配置
docs/                    架构、交互、核心语义及验收限制
```

## 故障排查与维护

- `CONFLICT`：其他实例或编辑器已改变文件，重新加载并重新应用修改。
- `INVALID_CONFIG`：备份原 YAML，再用本地编辑器修复；不要复制包含凭据的解析上下文到日志。
- `KEY_MISSING` / `DECRYPT_FAILED`：恢复同一用户的安全存储备份，或在 GUI 输入新的 API Key；旧密文无法靠重置应用解密。
- `VAULT_UNAVAILABLE`：解锁系统凭据存储/Secret Service；不要选择自动明文降级。
- `COMMIT_UNCERTAIN`：提交后状态无法确认，重新读取有效配置，再决定后续操作，禁止盲目重试。
- `LOCK_TIMEOUT`：另一个进程持锁超过五秒，关闭繁忙实例或稍后重试，不要手动删除仍在使用的锁文件。
- `HISTORY_CORRUPT` / `HISTORY_PENDING`：先重新读取配置确认是否提交，备份 YAML 和所有旁车文件，再修复历史。不要只删除 pending 文件，否则可能丢失已提交记录。
- `UNSAFE_PATH`：不支持符号链接等不安全路径；将配置放在受当前用户控制的真实目录中。
- `IO`：确认用户有目标目录写权限、文件没有被其他程序独占、磁盘空间足够；不需要盲目管理员运行。
- 托盘、启动注册和窗口问题见设置警告与原生验收清单。

升级前在应用退出后备份 YAML、历史及系统凭据存储；应用卸载不应主动删除用户配置或 vault 条目。测试、清理操作只针对专用临时目录。配置格式版本由 ENC v1、应用设置 schema_version 和源码迁移说明管理；未知版本拒绝而非覆盖。

上游参考：[Tauri 2](https://v2.tauri.app/)、[Autostart](https://v2.tauri.app/plugin/autostart/)、[keyring 3.6.3](https://docs.rs/keyring/3.6.3/)、[AES-GCM](https://docs.rs/aes-gcm/0.10.3/)。本项目 MIT；依赖保留各自许可证，未捆绑用户凭据、系统凭据数据库或第三方模型客户端。
