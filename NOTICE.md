# 第三方、协议与商标声明

## 非官方项目

本项目是社区维护的独立兼容实现，不属于理想汽车、LiViS、Hermes 或 OpenClaw 官方项目，也不代表上述组织对本项目的认可、支持或担保。

LiViS、理想、理想汽车、Hermes、OpenClaw 及相关名称、标识和商标属于各自权利人。本项目仅为说明兼容目标而合理引用这些名称。

## 代码与 artifact 边界

- 除下文单列的行为准则归属外，MIT License 只覆盖本仓库自主实现的源代码和文档。
- 本仓库不包含或再分发 LiViS 官方插件包、`bundle.js`、安装脚本或其他官方二进制 artifact。
- 公开仓库不包含可直连生产服务的 live profile，也不附带官方 OAuth 客户端身份。`protocol-profiles/livis-authorized.example.json` 中的端点、OAuth 标识和哈希都是无效占位值。
- 使用者自行创建的本地 profile 可能包含公共客户端标识和受服务条款约束的端点；这些文件不会被 Git 默认收录。
- 上述兼容性信息不构成官方 SDK、协议稳定性承诺，也不授予访问相关服务的权利。

使用者应自行确认适用的服务条款、账号权限、网络与数据合规要求。若权利人认为本仓库存在不当内容，请通过仓库维护者的 GitHub 主页联系。

## 行为准则归属

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) 参考 Contributor Covenant 2.1，原作版权属于 Contributor Covenant 贡献者，并按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用；其归属与许可证不受本项目 MIT License 替代。
