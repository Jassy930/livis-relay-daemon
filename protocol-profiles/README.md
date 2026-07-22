# Protocol profile

公开仓库不附带可直接连接任何厂商生产服务的 live profile，也不默认复用官方 OAuth 客户端身份。

profile 只固定一次获授权部署的参数与 artifact，不证明真实服务端要求或接受对应 wire。证据等级、历史 canary 与协议变化门禁见[LiViS 服务端协议证据与支持边界](../docs/LIVIS-RELAY-PROTOCOL-BOUNDARY.md)。

使用者需要从有权管理相关服务的一方取得：

- 获授权的 IDaaS、relay 和下载端点；
- OAuth public client ID、audience、scope 与 logout URI；
- wire client 名称、身份前缀和 node type；
- 对应版本的 setup、install 和 package SHA-256；
- 经人工审阅的 wire marker。
- 与代码 registry 匹配的 `wireContractRevision` 和 `credentialMode`。

将 [`livis-authorized.example.json`](livis-authorized.example.json) 复制到仓库外的私有位置，填写获授权参数后执行：

```bash
bun run src/index.ts init \
  --profile '/绝对路径/authorized-profile.json' \
  --acknowledge-unofficial-protocol
```

profile 不是 secret，但可能包含受服务条款约束的客户端身份和内部端点，因此不要未经授权公开。仓库内的 `*.local.json` 和 `local/` 会被 Git 忽略。

当前 profile schema 为 v2。schema v1 不会自动推断凭据模式；现有部署只可在停服务、禁用自动拉起和人工审阅固定 r1 contract 后，使用显式 `profile migrate-v2` 迁移。命令不覆盖 v1 文件，以 config durable rename 提交，隔离旧/新 proof，并提供 receipt 驱动的回滚。完整步骤见[官方版本升级与回滚](../docs/UPSTREAM-UPGRADE.md#现有部署的-protocol-profile-schema-v1v2-迁移)。
