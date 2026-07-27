# 部署安装器架构与安全边界

## 1. 目标与非目标

部署安装器 v1 把当前“源码 checkout + 人工替换服务模板”的流程收敛为可审计事务：

```text
可信渠道取得 manifest SHA-256
→ 读回 release manifest 与两个归档
→ 完整产物审计
→ plan 零持久状态写入
→ install / upgrade 显式 apply
→ 写入私有收据和当前部署指针
→ 可验证 rollback / uninstall
```

安装器覆盖 Hermes、Codex 和 Claude 三种 execution backend，但不负责账号或认证：

- 不执行任何后端登录、退出、授权或刷新命令；
- 不读取、复制、迁移、分类或判断 Codex、Claude、Hermes 的原生认证状态；
- 不把 LiViS OAuth、`SecretStore` 或 daemon token 交给本地后端；
- 本地后端是什么状态就由其原生 runtime 在真正调用时呈现什么状态，安装器不提前修复或改写；
- rollback 与 uninstall 不删除 state directory、后端 workspace、原生凭据目录或操作者记忆目录。

## 2. 输入信任边界

正式安装只消费 `release-manifest.json` 指向的审计产物，不从当前任意 checkout 复制运行文件。操作者必须从独立可信渠道提供 manifest 的 SHA-256；安装器先比对该值，再要求：

- manifest 表明 `sourceTree=clean-git` 且携带完整 40 位 Git commit；
- 源码包和 Hermes bridge 包的文件名、唯一根目录、大小、SHA-256 与必需路径契约完整；
- 归档不含绝对路径、目录穿越、多根、符号链接、硬链接或发布白名单外内容；
- apply 阶段重新快照输入并复跑同一审计，不能把较早的 plan 结果直接当写入授权；
- 解包后运行 `bun install --frozen-lockfile --ignore-scripts --backend=copyfile`，避免生命周期
  脚本与依赖 hardlink 把 release 完整性外包给可变缓存；安装后同时固定发布文件和完整
  `node_modules` 树的 SHA-256 读回。

manifest SHA-256 只能绑定操作者拿到的字节，不能自行证明发布者身份。v1 不内置签名信任根；发布者身份与 manifest 哈希的可信分发仍是操作者门禁。

## 3. 稳定部署布局

默认部署根为用户私有目录，所有部署控制文件与收据为 `0600`，控制目录为 `0700`：

```text
<installRoot>/
├── current.json
├── releases/
│   └── <version>-<gitCommit前12位>/
└── receipts/
    └── <operationId>/
        ├── receipt.json
        ├── release-bundle/
        │   ├── release-manifest.json
        │   └── 两个发布归档
        └── service.before（仅原定义存在时）
```

服务定义指向精确 release 目录，不通过可变符号链接解析代码。state directory 必须位于 release 目录之外；升级不会迁移 SQLite、配置、profile、backend session 或 assistant context。

`current.json` 是部署提交点，只记录版本、commit、归档 SHA、backend、config 与收据路径，不记录 token 或后端身份。收据先以 `prepared` 落盘，提交和读回成功后才转为 `installed` 或 `upgraded`。

## 4. backend-aware 行为

| backend | 安装器行为 | 明确不做 |
| --- | --- | --- |
| Hermes | 要求操作者显式提供专用 `HERMES_HOME`；只从同一已审计发布集合的 bridge 归档调用原子 bridge 安装器并保存其收据 | 不创建 profile、不运行 Gateway、不操作默认 Hermes profile、不登录 |
| Codex | 只保留现有 config 中操作者选择的 command、mode 与 runtime 选择器；服务环境继续使用 native-current 白名单 | 不查看 `auth.json`、Desktop daemon 或账号类型，不复制 CODEX_HOME |
| Claude | 只保留现有 config 中操作者选择的 command、mode 与 runtime 选择器；服务环境继续使用 native-current 白名单 | 不查看 Keychain/凭据文件，不注入 token，不执行认证探针 |

backend 由现有 config 解析得出，CLI 不能另传一个不一致的 backend 覆盖它。

## 5. 服务管理副作用

`plan` 永远不写 deployment、config、stateDir 或服务状态，也不会调用 `launchctl` 或
`systemctl`。为完成归档内容审计，它会在系统临时目录解包并在返回前清理；这不是部署
提交点。`install`、`upgrade`、`rollback`、`uninstall` 的持久文件写入需要 `--apply`；
需要安装、停止、reload 或启动用户服务时，还必须同时传入服务副作用确认参数。

服务控制通过 `DeploymentServiceController` 注入，测试只使用内存 fake。生产控制器只允许精确 label/unit：

- macOS：`gui/<uid>/com.local.livis-relayd`；
- Linux user service：`livis-relayd.service`；
- `none`：只安装精确 release 与部署收据，不生成或操作服务定义。

Linux systemd 对 Hermes 与 Codex `private-api-key` 保持 `ProtectHome=read-only`；Codex 或
Claude `native-current` 必须让原生 runtime 按用户当前状态自行读写 home，因此生成
`ProtectHome=false`，但仍不注入任何认证环境变量。这个差异会进入服务定义 SHA 和部署
收据，plan 时必须人工核对。macOS LaunchAgent 不增加额外 HOME 沙箱；真正的工具与
workspace 约束仍由各 backend adapter 持有。

操作者选择不让安装器管理服务时，升级与回滚必须显式确认 daemon（Hermes 模式还包括专用 Gateway）已停止；安装器只更新磁盘定义并在结果中返回 `serviceRestartPerformed=false`。任何服务状态不明、定义读回不一致或启动失败都失败关闭，不能写成部署完成。

## 6. 操作状态机

### plan

读取并验证 manifest、归档、config、backend、目标布局和服务定义，输出确定性计划；除
临时解包审计外，不创建持久目录、不安装依赖、不写收据、不触发服务动作。

### install

仅在没有 `current.json` 时允许。apply 会私有快照发布输入、解包到 staging、安装锁定依赖、读回哈希；Hermes 再执行 bridge 原子安装。随后备份既有服务定义、写入新定义和部署收据，最后提交 `current.json`。

### upgrade

要求已有可验证 `current.json`，且新版本/commit/源码归档身份与当前部署不同。旧 release、旧服务定义和旧收据全部保留；不会就地覆盖当前 release。

### rollback

只能使用当前部署链中的安装或升级收据。执行前重查 `current.json` 与已安装 release 身份，拒绝覆盖部署后的人工改动；恢复上一份指针与服务定义。Hermes bridge 仅通过对应 bridge 安装收据回滚。

### uninstall

卸载只移除当前 daemon 服务定义和活动部署指针，保留 release、收据、config、state directory、Hermes bridge、Codex/Claude workspace、个人助手上下文及所有原生认证状态。进一步清理必须由操作者单独审阅和执行。

## 7. 可证明完成

一次操作只有同时具备以下证据才能称为完成：

1. 输入 manifest 固定 SHA 与两个归档审计通过；
2. release 解包与发布文件哈希读回一致；
3. 私有 `prepared` 收据存在；
4. 服务定义写入/删除结果读回一致，或计划明确为 `none`；
5. `current.json` 提交点与目标部署完全一致；
6. 最终收据状态读回为期望终态；
7. 若要求安装器管理服务，精确 label/unit 的最终状态读回通过。

这些证据不等于 LiViS 登录、upstream supported proof、backend readiness 或真实消息 canary。部署后仍必须按运维手册执行 `status`、`doctor --online` 和对应 backend 的真实闭环验证。
