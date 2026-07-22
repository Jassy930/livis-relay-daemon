# 机器可读能力契约

根目录 [`capabilities.json`](../capabilities.json) 是当前公开能力、证据等级、安全默认值、命令权限和发布产物的机器可读事实源；[`schemas/capabilities.schema.json`](../schemas/capabilities.schema.json) 使用 JSON Schema Draft 2020-12 严格约束结构和枚举值。

## 证据等级

- `live-canary-verified`：已在隔离 profile 和真实非生产链路完成 canary；仍只证明证据文档明确记录的版本、账号和路径。
- `offline-verified`：代码路径有确定性自动化测试，但尚不能据此宣称真实 App、眼镜或生产 relay 已验证。
- `operator-only`：能力只允许操作者从本机显式执行，不是远程 Agent 能力。
- `unsupported`：一期明确失败关闭，不能由 README、握手成功或上游格式声明推导为支持。

每项 `live-canary-verified` 能力必须至少绑定一份 `evidenceRefs`；每项 `offline-verified` 能力必须至少绑定一份 `testRefs`。所有引用必须是存在于项目树中的相对路径，不允许绝对路径或 `..`。

## 使用方式

只读输出：

```bash
bun run src/index.ts capabilities
```

维护门禁：

```bash
bun run capabilities:check
```

门禁会执行 JSON Schema 校验、能力 ID 唯一性、证据等级约束、引用路径存在性，以及与 `package.json` 的名称、版本和许可证一致性检查。`bun run version:check` 也会单独核对能力契约版本。

## 更新规则

1. 行为、支持范围、安全默认值或验证状态变化时，必须同步修改 `capabilities.json`、实现、测试和中文文档。
2. 不得只把状态从 `offline-verified` 提升为 `live-canary-verified`；必须增加可读回的真实 canary 证据。
3. 新增状态、方向或顶层结构必须先更新 JSON Schema，并补拒绝无效输入的测试。
4. 机器可读契约不包含生产端点、官方 OAuth client identity、token、node/device/agent ID 或本机绝对路径。
5. 发布包必须同时携带能力契约和 Schema，解包审计会验证二者存在。
