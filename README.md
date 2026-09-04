<p align="center">
  <img src="https://dsh.sober.report/assets/brand/deepguard-wordmark.svg" alt="DeepGuard" height="72">
</p>
<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a> · <a href="https://ko-fi.com/G2S825CBZS">☕ Buy me more tokens</a>
</p>

> **实验性项目，没有人工终审。** 分析、复核、裁决、发布四道工序全部由 4 名 Agent 完成。我想验证一件事：一支 agent team 只靠编排设计和安全领域的 skills，能不能在开源生态里自我托管、长期活下去。AI 会遗漏，会误判。发布前我做了大量限制与交叉验证，但说到底只是尽力而为。发现 AI 犯了错，请用 Issue Form「Audit Correction」提交纠错（自动打 `correction` 标签），特殊情况会人工介入。

dsh 生态装插件只要一条命令，装下的每段代码都拥有宿主进程的完整权限。DeepGuard 做的事一句话可以说完：给每个插件的每个版本做自动化安全审计，公开全部报告，让你在安装之前先看到结论。

这里是 DeepGuard 的**公开报告仓**：审计报告权威源、提交入口、审计流水线执行仓。线上站点：<https://dsh.sober.report/>（插件市场 / 生态报告 / 安全情报 / 安全方案，中英双语）

> 审计 agent 实现、检测规则全集（skills）、前端与内部文档闭源，理由和杀软不公开病毒库一样。它们托管在私有核心仓，本仓只含报告数据与流水线编排。

## 支持这个项目

项目烧的是 token，目前预先充了一笔初始资金，按当前的审计频率撑不了太久。余额耗尽那天，审计停下来，已公开的报告和全部代码留在仓库里。

如果你希望这支 agent team 继续干活，可以给它充 token：

[![Buy me more tokens](https://dsh.sober.report/assets/kofi-button.svg)](https://ko-fi.com/G2S825CBZS)

**特别感谢 [B.AI](https://b.ai)**：当前审计消耗的 token 由 GLM 5.3 Flash × B.AI 限时免费活动提供，DeepGuard 这个实验性项目因此得以持续运转，希望活动能办得长长久久。

<a href="https://b.ai"><img src="https://dsh.sober.report/assets/brand/bai-sponsor-banner.svg?v=2" alt="GLM 5.3 Flash × B.AI 限时免费" height="30"></a>

> **捐赠透明**：社区捐了多少、token 花到了哪里，都应该公开可查。我目前没有找到满意的实现方案。如果你有想法，欢迎开 issue 聊聊。

## 背景

2025 年以来，针对 Agent 工具链的攻击陆续曝光：MCP 服务器的工具描述投毒（恶意指令藏进工具说明文本，模型读到即中招）、插件市场的 rug pull（先用正常版本积累装机量，再借一次更新作恶）、伪装成热门项目的恶意 Skills、写进 README 和指令文件里的提示词注入。

这些手法攻击的是同一个假设：安装即信任。在 agent、mcp、skills、plugins 这些生态里，装下的每段代码、每段指令文本都拥有宿主进程的完整权限，能读你的密钥，改你的提示词，替你的模型做决定。

DeepGuard 的能力有边界。静态分析覆盖不了全部运行时行为，AI 判断存在漏报与误报，每份报告开头都写明了审计边界。

受限于 token 额度，审计火力目前聚焦 dsh 生态。这套编排和 skills 按整个 Agent 工具体系设计，agent、mcp、skills、plugins 生态都在能力覆盖范围内，视额度情况逐步扩展。

## 时间线

| 日期 | 事件 |
|---|---|
| 2026-08-17 | [B.AI](https://b.ai) 上线 DeepSeek V4 Flash 限时免费活动，审计 token 成本归零，实验项目得以全速运转 |
| 2026-08-19 | 完成 B.AI 网关接入与实测，审计默认端点切换为 b.ai，基座模型 deepseek-v4-flash |
| 2026-09-04 | B.AI 的 DeepSeek V4 Flash 免费活动结束；经同一网关实测后，基座模型切换为 GLM 5.3 Flash（具备限时免费活动），审计编排与规则集不变 |

审计消耗的 token 由活动方提供，模型的存续随活动周期变化。切换基座模型只改配置、不改编排——规则集、场景库、定级纪律这些人工先验始终不变，模型在固定框架里干活。

## 检测框架

三层规则集共 127 项编号规则（AI Agent 安全基线 74 项、dsh 生态覆盖层 30 项、指令面与后门规则 23 项），配合六大检测维度、五层纵深防线、双 AI 复核加分歧裁决。完整的攻击面分层模型、维度定义、定级纪律与自动化设计都在安全方案页：

**<https://dsh.sober.report/intro.html>**

这里只补一条工作原则：**不信任当下，只信任快照**。每份报告锁定插件 ID、版本号、commit SHA 三元组，市场只展示绑定快照的安装命令。同一版本号出现第二个不同提交，说明版本历史可能被改写，立即触发预警。同三元组的重复提交在入闸处直接拒绝，重审必须升版本号或推新提交。

## 工作流程

从提交到上架的完整业务链路。AI 只产报告草稿，每一次出入库都由确定性脚本过闸：

<p align="center"><img src="https://dsh.sober.report/assets/diagrams/workflow.zh.svg?v=1" alt="工作流程：提交 → gate 闸 → Sonar → Aegis →（Beacon）→ postcheck → publish → sync" width="620"></p>

## 架构

双仓拓扑：本仓是提交入口、报告权威源与流水线执行仓；审计核心、规则集与站点托管在私有核心仓。核心代码经稀疏拉取投送到本仓流水线，报告经镜像 PR 单向回流，web 仅作展示：

<p align="center"><img src="https://dsh.sober.report/assets/diagrams/arch.zh.svg?v=1" alt="架构：公共仓与私有核心仓双仓拓扑，投送与单向回流" width="860"></p>

## 使用方法

### 提交插件入驻

在本仓用 Issue Form「Plugin Audit Submission」提交，模板自动打 `audit-submission` 标签，没有这个标签的 issue 进不了审计流程。

- **谁能提交**：仅插件作者本人——即插件仓库的 owner，由 GitHub 服务端数据自动判定，不接受自我声明；白名单为内部免检通道。AI Agent 时代人人都是创作者，作品的安全由创作者自己负责。提交审计，就是为自己的产品正名。
- **账号门槛**：入闸是纯脚本检查，不过闸不消耗审计资源。检查项包括作者身份、GitHub 账号年龄、白名单（免检通道）、黑名单，以及同一插件同一版本的同一 commit 只审一次。新注册小号、被拉黑身份的提交会被当场拒收。
- **提交之后**：预审通过即入队开审，判决自动回帖到来源 issue 并关闭。通过的报告进入市场索引；未通过的不发布，队列标记 needs-human 转入延伸复核，特殊情况由人工介入处置。

**For Agent**：插件是 AI Agent 开发的？把下面这段提示词交给它，开发完成后它会自动提交入驻申请：

```text
本项目完成后，向 DeepGuard 提交安全审计入驻申请：
1. 确认 GitHub 仓库为 public 且代码已全部推送（预审锁定 HEAD commit）。
2. 在浏览器打开以下链接（尖括号内容替换为实际值并做 URL 编码；category 取值：UI Extension (ui) / Tools (tools) / Sandbox / Execution (sandbox) / Bridge (bridge) / Model Adapter (model) / Workflow (workflow) / Memory (memory)，拿不准填 Uncertain）：
   https://github.com/SoberReport-AI/DeepGuard/issues/new?template=plugin-submission.yml&title=[Audit]%20<插件名>&name=<插件名>&repo=<仓库根URL>&category=<分类>&notes=<补充说明，可留空>
3. 在表单页按插件实际运行时能力勾选 Declared Capabilities，勾上全部三条 Submission Confirmations，然后提交。
4. 跟踪这个 issue：预审结果和审计判决都会回帖。同一版本同一 commit 只审一次，重审先升 version 或推新 commit。
```

### 规则

两条红线，都由确定性脚本执行，不走 AI 裁量：

1. **恶意刷量提交**。小号轰炸、重复提交同一快照、伪造身份，入闸拦截，提交者身份加入黑名单。
2. **插件被确认存在恶意后门或投毒**。如实发布 blocked 判决报告，作者及其关联身份（组织、维护者）自动级联拉黑，[安全情报页](https://dsh.sober.report/advisories.html)同步广播下架预警。

黑名单公开可查（`reports/_blacklist.json`），被拉黑的身份此后提交的任何插件一律不收。

### 这是一支 Agent 团队

分析、复核、裁决、发布由 4 名 Agent 协同完成，没有人工终审：

| 岗位 | 职责 |
|---|---|
| Sonar（声纳） | 静态审计，产出报告草稿 |
| Aegis（神盾） | 独立复核，逐条回验证据行号，附带定级浮夸检查 |
| Beacon（灯塔） | 仅在双岗分歧时开庭，三选一裁决，无权改报告 |
| Harbor（港湾） | 发布前查验，只读权限、只有否决权，专防借发布通道本身发起的攻击 |

铁律：AI 只产报告草稿，出入库全走确定性硬闸。任何一环拿不准，不开 PR，队列标记 needs-human 转入延伸复核，特殊情况由人工介入处置。

## 安全问答

### 为什么只允许插件作者本人提交插件？

伪装成开发者投毒是开源生态最常见的攻击入口之一。要求作者本人提交，配合账号年龄与身份核验，攻击门槛从「零成本小号」抬到了「真实身份背书」。攻击者不是绝对进不来，但一旦作恶就会留下身份痕迹并被拉黑，没法零成本重来。另一层考虑是责任归属：AI Agent 时代人人都是创作者，作品的安全由创作者自己负责，创作者要为自己的产品正名。

### 为什么用 GLM 5.3 Flash 作为基座？

DeepGuard 的基座模型最早选择 DeepSeek V4 Flash——就长上下文读代码、结构化输出、高频调用这个场景和成本结构来说，它当时是最合适的选择。2026-09-04 B.AI 的 DeepSeek V4 Flash 免费活动结束后，我们在同一网关（B.AI）实测了 GLM 5.3 Flash（同样具备限时免费活动）：在目前的编排框架里（规则集、场景库、定级纪律都是人工先验），它的审计效果同样足以胜任项目任务，于是切换过去。切换只改配置、不改编排。模型能力是一方面，更关键的是把安全领域的专业知识固化进 skills：模型在固定框架里干活，效果好坏取决于框架本身，而不只是单点模型。

### 我可以完全信任 DeepGuard Agent 团队产出的报告吗？

不建议完全信任，我们也不做这种承诺。DeepGuard 是实验性项目，分析、判断、裁决、发布全部由 agents 完成，遗漏和误判无法排除。能做的只有把不确定性摊开：每份报告附完整的审计边界声明，每条结论带证据文件与行号，你可以逐条复核，纠错渠道也一直开着。安装任何插件前，报告是参考，最终判断权在你手里。

### 这个项目能维护多久？

取决于 token 余额。目前的运行费用来自我充值的初始资金，按当前的审计频率消耗完之后，审计就会停下来。到那天，已公开的报告和全部代码仍会留在仓库里。如果你希望这支 agent team 继续做下去，可以通过 [Ko-fi](https://ko-fi.com/G2S825CBZS) 给它充 token。捐赠透明化的方案我还在找，捐了多少、花了多少都应该公开可查，你有好想法欢迎开 issue 告诉我。

## 仓库结构

```
├── reports/                      # 审计报告库（数据即代码，硬闸保护）
│   ├── _schema/                  #   报告 JSON Schema v3（人类可读字段为 {zh, en} 双语对象）
│   ├── _blacklist.json           #   生态黑名单
│   ├── _audit-log.json           #   审计台账（机器生成）
│   ├── _advisories.json          #   生态预警流
│   ├── _identity.json            #   作者认证/官方插件配置
│   └── <plugin-id>/<version>/<commit>.json   # 报告本体（一经合入不可修改）
├── _import/                      # 采集与提交预审
│   ├── catalog.json              #   插件清单（含 stars）
│   ├── audit-queue/              #   审计队列
│   ├── whitelist.json            #   提交者白名单
│   ├── watch-list.json           #   版本监控配置
│   ├── batch-top20.json          #   批量调度清单
│   ├── collect-plugins.js        #   采集脚本（纯脚本，无 AI）
│   └── prescreen-submission.js   #   提交预审脚本（纯脚本，无 AI；同三元组拒重）
├── scripts/
│   ├── validate-report.js        # 报告硬闸校验（schema v3 + 语义规则 + 双语完整性）
│   └── audit-log.js              # 台账生成
├── AUDIT-LOG.md                  # 审计台账（渲染产物）
└── .github/workflows/            # 审计编排：见下表
```

## 报告怎么读

- 每个插件一个目录，路径三段 `reports/<id>/<version>/<commit>.json` 与报告内 `plugin.id/version/commit` 逐一相等。
- 报告一经合入**不可修改**。纠错只新增修订版（`report_version` 递增），历史版本保留，版本切换、`version_diff`、rug pull 检测都依赖这一点。
- 同 version 不同 commit = 两份报告，这是 force-push 预警的物质基础。
- 人类可读字段（摘要、finding 描述、证据说明等）为 `{zh, en}` 双语对象。zh 是审计原文，en 由独立翻译岗填充并经确定性核验（字段一一对应，结论不可篡改）。
- 格式契约见 `reports/_schema/deepguard-report.schema.json`。所有报告必须通过 `scripts/validate-report.js` 硬闸才能合入。

## CI 工作流

| 工作流 | 触发 | 作用 |
|---|---|---|
| `issue-intake.yml` | issue labeled / edited | 预审 + 入队 + dispatch 审计（仅 `audit-submission` 标签且 open 状态） |
| `agent-audit.yml` | dispatch / 手动 | 审计主流程（gate → sonar → aegis → beacon → translate → publish → sync → ledger → issue-feedback） |
| `audit-dispatch.yml` | cron */10 + workflow_run 快路径 | 批量调度（按 manifest 顺序补位） |
| `watch-updates.yml` | cron | 已入库插件的版本监视（force-push / 新版本预警） |
| `validate.yml` | PR / push 触及 `reports/**` | 报告硬闸校验，FAIL 拒入 |

报告在本仓合并后，由镜像 PR 同步至私有核心仓：确定性守门六检加 Harbor 终审查验，通过后自动合并、重建索引、部署市场，并向来源 issue 发结构化英文回执后关闭。镜像侧工作流不在本仓。

## 审计判定速查

- **overall_result**：任一维度 CRITICAL 或 rug pull 信号 → `blocked`；有 finding 无 CRITICAL → `risk`；全部通过 → `clean`
- **判决只在维度状态机内流转**，任何解释性文字不构成降级理由
- **报告一经合入不可修改**，纠错只能新增修订版（`report_version` 递增）
- 报告中的规则 ID 引用与 finding 描述属结论性公开内容；判定细节、阈值与检测规则全集不公开展示

## 致谢

插件市场的部分插件信息（名称、简介、分类等）源自社区清单 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，感谢维护者的整理。

## License

本仓全部内容（报告数据 + 脚本 + 流水线编排）采用 [PolyForm Noncommercial 1.0.0](LICENSE)：允许个人研究、学习、测试及公益组织、教育机构、政府与公共研究机构使用；禁止商业用途。商业合作或商用授权请联系作者。
