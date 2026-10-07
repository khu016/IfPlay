# IfPlay

把一句游戏想法变成能在浏览器里玩的小游戏。

IfPlay 面向不会编程的普通用户和内容创作者。用户用中文描述题材、身份和玩法，系统生成网页小游戏，随后可以直接试玩，并用自然语言继续调整。

当前目标是在两天内完成一个可完整演示的测试版：第一天跑通后端，第二天接通前端。测试版用于验证产品主链路，不代表已经具备正式公开上线所需的安全、合规和稳定性能力。

## 核心体验

1. 输入一句中文游戏想法。
2. AI 最多询问三个关键问题。
3. 比较三个有实质差异的玩法提案，并选择视觉方向。
4. 确认玩法契约后查看真实生成阶段和结果。
5. 在浏览器里完成一轮试玩。
6. 用结构化反馈或自然语言提出修改并生成新版本。

核心链路不得出现阻断问题。轻微界面或文案问题可以暂时进入后续清单，但内容必须能够继续调整。

## 当前阶段

- [x] 建立独立仓库与 v1.0 PRD。
- [x] 完成需求健康检查和两天交付边界。
- [x] 核对 OpenGame 的复用方式、许可证和模型接入能力。
- [x] 完成 IfPlay 后端任务接口、双并发队列和版本保存。
- [x] 完成创作、生成、试玩和修改界面。
- [x] 完成本地演示模式的端到端验收记录。
- [x] 完成 DeepSeek + OpenGame 真实生成验收。
- [x] 完成 DeepSeek 结构化玩法策划后端与真实接口验证。
- [x] 完成关键问题、三个玩法提案和选择恢复的前端界面。
- [x] 完成三分区参考风格板和玩法契约确认。
- [x] 完成结构化试玩反馈和定向修改确认。
- [x] 完成版本历史、预览与无模型恢复。
- [x] 完成五类代表需求的 MVP 总验收与交付清单（5/5 通过）。

项目状态见 [docs/项目状态.md](docs/项目状态.md)，完整需求见 [PRD-IfPlay-MVP-v1.0.md](PRD-IfPlay-MVP-v1.0.md)。

## 技术路线

IfPlay 直接基于 [OpenGame](https://github.com/leigest519/OpenGame) 的游戏生成能力开发：

- 保留 OpenGame 的 Agent、Game Skill、构建和调试能力。
- 在外层增加 IfPlay 的 HTTP 接口、项目状态、任务队列、版本记录与前端产品流程。
- 主模型通过 OpenAI 兼容接口接入 DeepSeek。
- 图片生成使用阿里云通义/万相能力。
- 视频生成和云端音频不进入本轮测试版。

测试期全部服务月度预算不超过 200 元，同时生成任务最多 2 个。提示词、代码、图片、日志和用户数据必须在中国大陆境内处理和存储。

## 开发说明

本仓库不提交模型密钥、访问令牌、匿名项目凭证或本地生成记录。真实服务和开发替身必须明确区分，模拟结果不能当作真实模型结果展示。

### 启动后端测试版

```bash
cp .env.example .env
npm start
```

默认页面地址是 `http://127.0.0.1:8787`，健康检查为 `GET /api/health`。默认使用明确标识的本地演示生成器，不会调用模型或产生模型费用。

玩法策划接口为 `POST /api/projects/:id/planning`。第一次调用会返回一个关键问题或三个玩法提案；存在待回答问题时，在请求体中提交 `{ "answer": "用户回答" }`。`GET /api/projects/:id/planning` 可以恢复已保存的问答与提案。两个接口都需要项目凭证。

提案选择接口为 `POST /api/projects/:id/planning/selection`，请求体为 `{ "proposalId": "proposal-a" }`。选择会写入项目状态并在刷新后恢复。

确认玩法后，`POST /api/projects/:id/planning/style-board` 会调用万相生成一张三分区参考风格板。图片通过带项目凭证的 `GET /api/projects/:id/planning/style-board/image` 读取，不依赖供应商的 24 小时临时地址。视觉选择写入 `POST /api/projects/:id/planning/style-selection`，请求体为 `{ "styleId": "style-a" }`。最后调用 `POST /api/projects/:id/planning/contract/confirm` 确认玩法合同；未确认合同的策划项目不能启动首版生成。

试玩后通过 `POST /api/projects/:id/feedback/preview` 提交 `{ "feedback": "节奏太慢", "category": "pace" }`。DeepSeek 会返回并保存“会改变、保持不变、是否触碰玩法合同、预计消耗”的修改计划，但此时不会创建生成任务。用户确认后再调用 `POST /api/projects/:id/feedback/confirm`，请求体为 `{ "planId": "..." }`；后端只使用已保存的计划创建新版本任务，不信任客户端临时拼接的修改指令。

版本列表接口 `GET /api/projects/:id/versions` 只返回安全的版本摘要，不暴露服务端文件路径。`GET /api/projects/:id/versions/:versionId/preview` 可以预览任一保留版本；`POST /api/projects/:id/versions/:versionId/restore` 会创建一个指向旧产物的新版本，不调用模型、不覆盖历史，并把本次费用记录为 0 元。

需要验证真实 OpenGame 时，先初始化子模块并安装上游依赖：

```bash
git submodule update --init --recursive
npm run setup:opengame
```

然后在 `.env` 中填写模型配置，并显式切换 `IFPLAY_GENERATOR_MODE=opengame`。当前真实模式仅用于受控本地测试，不能作为生产沙箱。

运行后端自动测试：

```bash
npm test
```

Stage 10 的五类真实验收可用 `npm run acceptance:stage10` 续跑。该命令会调用真实策划、图片和游戏生成服务，可能产生费用；已完成项目会复用本地状态，不重复生成。验收结论与边界见 [docs/阶段文档/Stage10-MVP总验收.md](docs/阶段文档/Stage10-MVP总验收.md)。

## 开源说明

IfPlay 参考并改造 OpenGame。OpenGame 使用 Apache License 2.0，相关版权与许可证信息会随引入的代码保留。第三方来源记录见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
