# Gonka Router 接入文档

本文档说明本项目如何通过 Gonka Router 调用多个大模型，完成志愿信息核验 Demo 的多模型交叉验证。

## 接入目标

用户输入一句待核验说法后，后端会：

1. 识别用户说法中的学校和话题
2. 从 Supabase 学生反馈库中检索相关上下文
3. 通过 Gonka Router 同时调用两个模型
4. 要求模型只返回 JSON
5. 聚合两个模型的判断，生成最终核验报告

## 使用的模型

默认模型配置在 `mock-verify-server-updated.js` 中：

```js
const GONKA_MODEL_A = process.env.GONKA_MODEL_A || "MiniMaxAI/MiniMax-M2.7";
const GONKA_MODEL_B = process.env.GONKA_MODEL_B || "moonshotai/Kimi-K2.6";
```

可以通过环境变量替换模型：

```env
GONKA_MODEL_A=MiniMaxAI/MiniMax-M2.7
GONKA_MODEL_B=moonshotai/Kimi-K2.6
```

## 环境变量

请在本地 `.env` 或部署平台环境变量中配置：

```env
GONKA_BASE_URL=https://api.gonkarouter.io/v1
GONKA_API_KEY=your_gonka_router_api_key
GONKA_MODEL_A=MiniMaxAI/MiniMax-M2.7
GONKA_MODEL_B=moonshotai/Kimi-K2.6
GONKA_MODEL_A_NAME=MiniMax-M2.7
GONKA_MODEL_B_NAME=Kimi-K2.6
```

不要把真实 API Key 提交到 GitHub。

## 调用方式

后端通过 Gonka Router 的 Chat Completions 接口调用模型：

```http
POST https://api.gonkarouter.io/v1/chat/completions
Authorization: Bearer <GONKA_API_KEY>
Content-Type: application/json
```

请求体结构：

```json
{
  "model": "MiniMaxAI/MiniMax-M2.7",
  "messages": [
    {
      "role": "user",
      "content": "核验提示词..."
    }
  ],
  "temperature": 0.2
}
```

## 模型提示词要求

项目要求模型遵守以下规则：

- 只输出 JSON
- 不输出 Markdown
- 不编造学校政策、录取位次、就业数据
- 区分官方信息、学生反馈和模型推测
- 证据不足时明确说明不确定原因

当前模型期望返回：

```json
{
  "verdict": "可信/部分可信/存疑/不可信",
  "confidence": 0.75,
  "reason": "判断理由",
  "risk_tags": ["风险标签"],
  "used_evidence_ids": ["rag-123"],
  "missing_evidence": ["还需要补充哪些证据"]
}
```

## 多模型聚合逻辑

后端会并发调用两个模型：

```js
const modelResults = await Promise.all([
  callGonkaModel(GONKA_MODEL_A, GONKA_MODEL_A_NAME, claim, ragContext),
  callGonkaModel(GONKA_MODEL_B, GONKA_MODEL_B_NAME, claim, ragContext),
]);
```

聚合规则：

- 取两个模型 `confidence` 的平均值作为 `truth_score`
- 如果两个模型 `verdict` 不一致，标记为“模型存在分歧，建议人工复核”
- 合并两个模型的 `risk_tags`
- 合并两个模型提出的 `missing_evidence`
- 将检索到的 RAG 上下文作为 `evidence` 返回给前端

## 主要接口

### POST `/api/verify`

前端调用该接口完成实时核验。

请求：

```json
{
  "claim": "深圳大学人工智能是不是一定比计算机更好就业？"
}
```

返回示例：

```json
{
  "claim": "深圳大学人工智能是不是一定比计算机更好就业？",
  "status": "completed",
  "truth_score": 42,
  "verdict": "存疑",
  "summary": "两个模型判断较一致，但仍需结合官方来源和 RAG 证据确认。",
  "risk_tags": ["绝对化表述", "缺乏官方就业数据"],
  "models": [
    {
      "role": "MiniMax-M2.7",
      "verdict": "存疑",
      "confidence": 0.4,
      "reason": "该说法包含“一定”等绝对化表达。",
      "evidence_ids": []
    },
    {
      "role": "Kimi-K2.6",
      "verdict": "部分可信",
      "confidence": 0.45,
      "reason": "需要结合学校就业质量报告进一步确认。",
      "evidence_ids": []
    }
  ],
  "evidence": [],
  "conflicts": [],
  "next_questions": ["需要补充近年就业质量报告"]
}
```

## 错误处理

如果未配置 `GONKA_API_KEY`，模型结果会返回：

```json
{
  "verdict": "未调用",
  "confidence": 0,
  "reason": "GONKA_API_KEY 未配置。",
  "risk_tags": ["API Key 未配置"]
}
```

如果 Gonka Router 返回非 200 响应，后端会将模型状态标记为“调用失败”，并把错误信息写入模型判断结果中。

## 黑客松演示建议

演示时建议强调：

1. 用户输入的是网络上常见的“未经核验说法”
2. 系统不是只问一个模型，而是通过 Gonka Router 并发调用多个模型
3. 不同模型给出各自判断、理由和风险标签
4. 后端再汇总为一个可读的核验报告
5. 证据不足时，系统会提示继续查证，而不是强行给确定结论

当前最低提交版重点展示“多模型验证 + 风险识别 + 结构化报告生成”。官方证据库已经作为扩展数据包保留，后续可以继续接入到 RAG 流程。

