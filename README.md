# Truth Verify 志愿信息核验 Demo

一个面向高中生和家长的志愿信息核验 Demo。用户可以输入关于大学、专业、宿舍、就业、校区等说法，系统会调用 Gonka Router 上的多个大模型进行交叉判断，并生成结构化核验报告。

在线 Demo：<https://truth-verify.onrender.com>

## 核心能力

- 支持用户自主输入待核验说法
- 调用两个 Gonka Router 模型进行多模型交叉验证
- 输出可信度、综合结论、风险标签、模型判断和后续追问建议
- 支持 Supabase 保存核验报告
- 提供学校生活质量反馈库和官方信息演示数据包，便于后续扩展 RAG/证据溯源

## 技术栈

- 前端：HTML / CSS / JavaScript
- 后端：Node.js HTTP Server
- 模型调用：Gonka Router Chat Completions API
- 数据库：Supabase
- 部署：Render

## 项目结构

```text
.
├── truth-verify-demov2.html          # 当前演示前端页面
├── truth-verify-api.js               # 前端 API 请求封装
├── mock-verify-server-updated.js     # 当前后端服务入口
├── package.json
├── package-lock.json
├── GONKA_ROUTER.md                   # Gonka Router 接入文档
├── .env.example                      # 环境变量示例
├── supabase-verify-reports.sql       # 核验报告表结构
├── supabase-official-rag.sql         # 官方信息 RAG 扩展表结构
├── import-official-rag.js            # 官方信息导入脚本，扩展用
├── official-info-demo-db-package/    # 官方信息演示数据包
└── 志愿信息核验_UI页面图/             # 产品 UI 图片素材
```

## 本地运行

1. 安装依赖

```bash
npm install
```

2. 创建环境变量

复制 `.env.example` 为 `.env`，填写 Gonka Router 和 Supabase 配置。

```bash
cp .env.example .env
```

3. 启动服务

```bash
npm start
```

4. 打开页面

```text
http://localhost:3000
```

健康检查：

```text
http://localhost:3000/health
```

## API 说明

### POST `/api/verify`

用于核验用户输入的一句话。

请求示例：

```json
{
  "claim": "深圳大学人工智能是不是一定比计算机更好就业？"
}
```

返回内容包含：

- `truth_score`：可信度评分
- `verdict`：模型综合判断
- `summary`：综合说明
- `risk_tags`：风险标签
- `models`：不同模型的判断结果
- `evidence`：当前检索到的学生反馈证据
- `conflicts`：模型分歧点
- `next_questions`：建议继续追问的问题

### GET `/api/verify-reports`

读取已保存的核验报告。需要先在 Supabase 执行 `supabase-verify-reports.sql`。

### POST `/api/school-compare`

对多个学校进行生活体验维度对比，主要用于扩展演示。

## Supabase 初始化

最低演示只需要执行：

```sql
-- 在 Supabase SQL Editor 中执行
supabase-verify-reports.sql
```

如果要继续扩展官方信息 RAG，再执行：

```sql
supabase-official-rag.sql
```

并运行：

```bash
node import-official-rag.js
```

当前最低提交版不强制接入官方 RAG，重点展示 Gonka Router 多模型核验流程。

## 推荐演示问题

建议演示时固定使用以下问题，避免现场输入过于发散：

1. 深圳大学人工智能是不是一定比计算机更好就业？
2. 华南师范大学宿舍条件是不是都一样？
3. 浙江大学转专业是不是超级容易？

这些问题可以展示夸大表达识别、多模型判断、风险标签和结构化报告生成。

## 部署说明

Render 部署时：

- Build Command：`npm install`
- Start Command：`npm start`
- Environment Variables：参考 `.env.example`

部署完成后访问根路径 `/` 即可打开前端页面。

## 注意事项

- 不要提交 `.env`
- 不要提交 `node_modules`
- Gonka Router API Key 只应配置在部署平台环境变量中
- 当前版本是黑客松 Demo，模型判断不能替代学校官网、招生章程、就业质量报告等官方信息

