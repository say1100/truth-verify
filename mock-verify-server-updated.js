const http = require("http");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const GONKA_BASE_URL = process.env.GONKA_BASE_URL || "https://api.gonkarouter.io/v1";
const GONKA_API_KEY = process.env.GONKA_API_KEY || "";
const GONKA_MODEL_A = process.env.GONKA_MODEL_A || "MiniMaxAI/MiniMax-M2.7";
const GONKA_MODEL_B = process.env.GONKA_MODEL_B || "moonshotai/Kimi-K2.6";
const GONKA_MODEL_A_NAME = process.env.GONKA_MODEL_A_NAME || "MiniMax-M2.7";
const GONKA_MODEL_B_NAME = process.env.GONKA_MODEL_B_NAME || "Kimi-K2.6";
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS || 15000);
const COMPARE_MODEL_TIMEOUT_MS = Number(process.env.COMPARE_MODEL_TIMEOUT_MS || 18000);
const ENABLE_DEMO_CACHE = process.env.ENABLE_DEMO_CACHE !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim();
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function isSupabaseReady() {
  return Boolean(supabase);
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

function nowMs() {
  return Date.now();
}

function logTrace(traceId, step, startedAt, extra = {}) {
  const ms = nowMs() - startedAt;
  console.log(JSON.stringify({ trace_id: traceId, step, ms, ...extra }));
  return nowMs();
}

function createTimeoutResult(model, displayName, timeoutMs) {
  return {
    model,
    display_name: displayName,
    ok: false,
    verdict: "模型超时",
    confidence: 0,
    reason: `${displayName} 超过 ${Math.round(timeoutMs / 1000)} 秒未返回，已启用降级结果。`,
    risk_tags: ["模型超时"],
    missing_evidence: ["稍后重试或改用缓存示例"],
    timed_out: true,
  };
}

function withTimeout(promise, timeoutMs, fallbackFactory) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(fallbackFactory()), timeoutMs);
    }),
  ]);
}

function normalizeDemoText(text) {
  return String(text || "").replace(/\s+/g, "").toLowerCase();
}

const demoVerifyCases = [
  {
    match: ["转专业", "很容易"],
    report: {
      claim: "某大学转专业很容易，宿舍也不错，就业基本不用担心。",
      status: "completed",
      truth_score: 72,
      verdict: "部分可信",
      summary: "该说法有部分依据，但“很容易”“不用担心”属于夸大表达，需要确认学院、校区和年份范围。",
      risk_tags: ["片面表达", "需确认范围", "就业结论过宽"],
      models: [
        { role: "官方核验", verdict: "部分支持", confidence: 0.78, reason: "转专业通常存在申请通道，但具体门槛取决于学院名额、绩点和考核。", evidence_ids: [] },
        { role: "风险识别", verdict: "发现夸大", confidence: 0.86, reason: "“很容易”“不用担心”是绝对化表达，不能直接作为填报依据。", evidence_ids: [] },
      ],
      evidence: [],
      conflicts: ["不同学院和年份的转专业政策可能不同。"],
      limitations: ["该缓存结果用于 Demo 快速展示，真实提交仍应结合官方章程和就业质量报告。"],
      next_questions: ["目标学院近两年转专业通过率是多少？", "该专业对应哪个校区？", "就业数据是否细分到具体专业？"],
      recognized: { school: "未识别", topics: ["转专业", "宿舍住宿", "就业发展"] },
      source: "demo_cache",
    },
  },
  {
    match: ["计算机", "好就业"],
    report: {
      claim: "计算机专业一定好就业？",
      status: "completed",
      truth_score: 70,
      verdict: "存疑",
      summary: "计算机就业受学校层次、城市、个人项目能力和行业周期影响，“一定好就业”过于绝对。",
      risk_tags: ["绝对化表述", "过度简化", "缺少学校差异"],
      models: [
        { role: "就业分析", verdict: "谨慎采信", confidence: 0.72, reason: "就业机会多不等于所有学生都好就业，需要看培养质量和个人能力。", evidence_ids: [] },
        { role: "风险识别", verdict: "表达过宽", confidence: 0.82, reason: "“一定”忽略学校、方向和市场周期差异。", evidence_ids: [] },
      ],
      evidence: [],
      conflicts: ["行业热度与个体就业结果之间不能直接等同。"],
      limitations: ["需要目标学校就业质量报告和专业去向数据。"],
      next_questions: ["目标学校计算机专业就业去向如何？", "实习资源集中在哪些城市？"],
      recognized: { school: "未识别", topics: ["就业发展"] },
      source: "demo_cache",
    },
  },
];

function getDemoVerifyReport(claim) {
  if (!ENABLE_DEMO_CACHE) return null;
  const normalized = normalizeDemoText(claim);
  const hit = demoVerifyCases.find((item) => item.match.every((word) => normalized.includes(normalizeDemoText(word))));
  if (!hit) return null;
  return {
    ...hit.report,
    claim,
    performance: { cache_hit: true, mode: "demo_cache" },
  };
}

function sendText(res, statusCode, content, contentType) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(content);
}

function sendStaticFile(res, fileName, contentType) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { status: "not_found", message: `${fileName} not found` });
    return;
  }
  sendText(res, 200, fs.readFileSync(filePath), contentType);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function detectClaimIntent(claim) {
  const topicRules = [
    { topic: "dormitory", label: "宿舍住宿", keywords: ["宿舍", "寝室", "住宿", "四人间", "六人间", "空调", "独卫"] },
    { topic: "transport", label: "交通校区", keywords: ["交通", "地铁", "位置", "校区", "通勤"] },
    { topic: "environment", label: "校园环境", keywords: ["环境", "校园", "食堂", "生活", "饭", "好吃", "便利"] },
    { topic: "study", label: "学习升学", keywords: ["学习氛围", "保研", "考研", "升学", "绩点", "课程"] },
    { topic: "career", label: "就业发展", keywords: ["就业", "工作", "薪资", "大厂", "实习", "就业率"] },
    { topic: "transfer", label: "转专业", keywords: ["转专业", "换专业", "跨学院"] },
    { topic: "location", label: "地理位置", keywords: ["坐落", "位于", "地址", "城市", "深圳", "广州"] },
  ];

  const matchedRules = topicRules.filter((rule) => rule.keywords.some((word) => claim.includes(word)));
  return {
    topics: matchedRules.length ? matchedRules.map((rule) => rule.topic) : ["general"],
    topic_labels: matchedRules.length ? matchedRules.map((rule) => rule.label) : ["综合信息"],
  };
}

async function findSchoolByName(name) {
  if (!isSupabaseReady()) return null;

  const clean = String(name || "").trim();
  if (!clean) return null;

  const exact = await supabase
    .from("schools")
    .select("id,name,province,normalized_name,sample_count,answer_count")
    .eq("name", clean)
    .limit(1);

  if (exact.error) throw new Error(`Supabase school lookup failed: ${exact.error.message}`);
  if (exact.data && exact.data[0]) return exact.data[0];

  const normalized = clean.replace(/\s+/g, "").toLowerCase();
  const fallback = await supabase
    .from("schools")
    .select("id,name,province,normalized_name,sample_count,answer_count")
    .eq("normalized_name", normalized)
    .limit(1);

  if (fallback.error) throw new Error(`Supabase school lookup failed: ${fallback.error.message}`);
  return (fallback.data || [])[0] || null;
}

async function findMatchedSchool(claim) {
  if (!isSupabaseReady()) return null;

  const { data: schools, error } = await supabase
    .from("schools")
    .select("id,name,province,normalized_name,sample_count,answer_count")
    .limit(800);

  if (error) throw new Error(`Supabase schools query failed: ${error.message}`);

  return (schools || [])
    .filter((school) => school.name && claim.includes(school.name))
    .sort((a, b) => b.name.length - a.name.length)[0] || null;
}

function responseMatchesTopics(response, topics) {
  if (!topics.length || topics.includes("general")) return true;

  const topic = response.questions?.topic || "";
  const questionText = response.questions?.text || "";
  return topics.some((item) => {
    if (topic.includes(item)) return true;
    if (item === "dormitory") return /宿舍|寝室|住宿/.test(questionText);
    if (item === "transport") return /交通|地铁|校区|位置/.test(questionText);
    if (item === "environment") return /环境|食堂|生活|校园/.test(questionText);
    if (item === "study") return /学习|保研|考研|升学|课程/.test(questionText);
    if (item === "career") return /就业|工作|实习|薪资/.test(questionText);
    if (item === "transfer") return /转专业|换专业/.test(questionText);
    return false;
  });
}

async function retrieveRagContext(claim) {
  const intent = detectClaimIntent(claim);

  if (!isSupabaseReady()) {
    return {
      school: null,
      topics: intent.topics,
      topic_labels: intent.topic_labels,
      evidence: [],
      rag_context: "Supabase 未配置，无法检索学生反馈数据库。",
      warnings: ["SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 未配置"],
    };
  }

  const matchedSchool = await findMatchedSchool(claim);
  if (!matchedSchool) {
    return {
      school: null,
      topics: intent.topics,
      topic_labels: intent.topic_labels,
      evidence: [],
      rag_context: "未从 claim 中识别到明确学校名称，无法匹配学校反馈库。",
      warnings: ["请在说法中包含完整学校名称，例如：深圳大学宿舍条件很好。"],
    };
  }

  const { data: responses, error } = await supabase
    .from("responses")
    .select("id,answer,response_year,response_month,questions(text,topic)")
    .eq("school_id", matchedSchool.id)
    .limit(80);

  if (error) throw new Error(`Supabase responses query failed: ${error.message}`);

  const filtered = (responses || []).filter((item) => responseMatchesTopics(item, intent.topics));
  const picked = (filtered.length ? filtered : responses || []).slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const evidence = picked.map((item) => ({
    id: `rag-${item.id}`,
    title: item.questions?.text || "学生反馈",
    publisher: "学生反馈数据库",
    url: "",
    published_at: item.response_year ? `${item.response_year}${item.response_month ? `-${String(item.response_month).padStart(2, "0")}` : ""}` : "",
    fetched_at: today,
    quote: item.answer || "",
    scope: `${matchedSchool.name}${matchedSchool.province ? ` · ${matchedSchool.province}` : ""}`,
    supports: "student_feedback",
  }));

  return {
    school: matchedSchool,
    topics: intent.topics,
    topic_labels: intent.topic_labels,
    evidence,
    rag_context: evidence.length
      ? evidence.map((item) => `【${item.id}】${item.title}：${item.quote}`).join("\n")
      : "已识别学校，但当前学校/话题下没有检索到足够学生反馈。",
    warnings: evidence.length ? [] : ["RAG 学生反馈样本不足，需要补充官方来源或更换查询问题。"],
  };
}

function buildVerifyPrompt(claim, ragContext) {
  return [
    "你是一个志愿填报信息核验助手。",
    "请核验用户输入的非官方说法是否可信。",
    "要求：",
    "1. 只输出 JSON，不要输出 Markdown。",
    "2. 不确定时要说明不确定原因。",
    "3. 区分官方信息、学生反馈、推测判断。",
    "4. 不要编造学校政策、录取位次、就业数据。",
    "5. RAG 材料中的学生反馈只能作为体验参考，不能等同于官方结论。",
    "",
    `识别学校：${ragContext?.school?.name || "未识别"}`,
    `识别话题：${(ragContext?.topic_labels || []).join("、") || "综合信息"}`,
    "",
    "RAG 材料：",
    ragContext?.rag_context || "暂无 RAG 材料",
    "",
    "JSON 格式：",
    "{",
    '  "verdict": "可信/部分可信/存疑/不可信",',
    '  "confidence": 0.75,',
    '  "reason": "你的判断理由",',
    '  "risk_tags": ["风险标签"],',
    '  "used_evidence_ids": ["rag-123"],',
    '  "missing_evidence": ["还需要补充哪些证据"]',
    "}",
    "",
    `用户说法：${claim}`,
  ].join("\n");
}

async function callGonkaModel(model, displayName, claim, ragContext) {
  if (!GONKA_API_KEY || GONKA_API_KEY.includes("这里填")) {
    return {
      model,
      display_name: displayName,
      ok: false,
      verdict: "未调用",
      confidence: 0,
      reason: "GONKA_API_KEY 未配置。",
      risk_tags: ["API Key 未配置"],
      missing_evidence: ["需要在 .env 中填写 GONKA_API_KEY"],
    };
  }

  const response = await fetch(`${GONKA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GONKA_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: buildVerifyPrompt(claim, ragContext) }],
      temperature: 0.2,
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    return {
      model,
      display_name: displayName,
      ok: false,
      verdict: "调用失败",
      confidence: 0,
      reason: `GonkaRouter 返回错误：${response.status} ${rawText}`,
      risk_tags: ["模型调用失败"],
      missing_evidence: [],
    };
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return {
      model,
      display_name: displayName,
      ok: false,
      verdict: "解析失败",
      confidence: 0,
      reason: `模型响应不是合法 JSON：${rawText.slice(0, 300)}`,
      risk_tags: ["模型响应异常"],
      missing_evidence: [],
    };
  }

  const content = data.choices?.[0]?.message?.content || "";
  const parsed = parseModelJson(content);
  return {
    model,
    display_name: displayName,
    ok: true,
    verdict: parsed.verdict || "部分可信",
    confidence: Number(parsed.confidence || 0.6),
    reason: parsed.reason || content,
    risk_tags: Array.isArray(parsed.risk_tags) ? parsed.risk_tags : [],
    missing_evidence: Array.isArray(parsed.missing_evidence) ? parsed.missing_evidence : [],
    used_evidence_ids: Array.isArray(parsed.used_evidence_ids) ? parsed.used_evidence_ids : [],
    raw_content: content,
  };
}

function parseModelJson(content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    const matched = content.match(/\{[\s\S]*\}/);
    if (!matched) return {};
    try {
      return JSON.parse(matched[0]);
    } catch (innerError) {
      return {};
    }
  }
}

function mergeModelResults(claim, modelResults, ragContext) {
  const validResults = modelResults.filter((item) => item.ok && item.confidence > 0);
  const avgConfidence = validResults.length
    ? validResults.reduce((sum, item) => sum + item.confidence, 0) / validResults.length
    : 0.5;
  const verdicts = modelResults.map((item) => item.verdict).filter(Boolean);
  const hasConflict = new Set(verdicts).size > 1;

  return {
    claim,
    status: "completed",
    truth_score: Math.round(avgConfidence * 100),
    verdict: hasConflict ? "模型存在分歧，建议人工复核" : verdicts[0] || "部分可信",
    summary: hasConflict
      ? "两个模型对该说法的判断不完全一致，需要结合官方来源和 RAG 证据继续核验。"
      : "两个模型判断较一致，但仍需结合官方来源和 RAG 证据确认。",
    risk_tags: Array.from(new Set(modelResults.flatMap((item) => item.risk_tags || []))),
    models: modelResults.map((item) => ({
      role: item.display_name || item.model,
      verdict: item.verdict,
      confidence: item.confidence,
      reason: item.reason,
      evidence_ids: item.used_evidence_ids || [],
    })),
    evidence: ragContext?.evidence || [],
    conflicts: hasConflict ? ["两个模型给出的可信度或结论存在差异。"] : [],
    limitations: [
      ...(ragContext?.warnings || []),
      "模型结果不能替代学校官网、招生章程、就业质量报告等官方证据。",
      "当前 RAG 主要来自学生反馈数据库，不等同于官方依据。",
    ],
    next_questions: Array.from(new Set(modelResults.flatMap((item) => item.missing_evidence || []))).slice(0, 6),
    recognized: {
      school: ragContext?.school?.name || "未识别",
      topics: ragContext?.topic_labels || ["综合信息"],
    },
  };
}

function buildVerifyReportRow(report, requestBody = {}) {
  return {
    claim: report.claim || requestBody.claim || "",
    status: report.status || "completed",
    truth_score: Number(report.truth_score || 0),
    verdict: report.verdict || "",
    summary: report.summary || "",
    province: requestBody.province || "",
    subject: requestBody.subject || "",
    depth: requestBody.depth || "",
    recognized: report.recognized || {},
    risk_tags: report.risk_tags || [],
    evidence: report.evidence || [],
    conflicts: report.conflicts || [],
    models: report.models || [],
    report,
  };
}

async function saveVerifyReport(report, requestBody = {}) {
  if (!isSupabaseReady()) {
    return { saved: false, error: "Supabase is not configured" };
  }

  const { data, error } = await supabase
    .from("verify_reports")
    .insert(buildVerifyReportRow(report, requestBody))
    .select("id,created_at")
    .single();

  if (error) {
    return { saved: false, error: error.message };
  }

  return { saved: true, id: data?.id, created_at: data?.created_at };
}

async function handleVerify(req, res) {
  const traceId = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let stepStarted = nowMs();
  const totalStarted = stepStarted;
  const body = await readJsonBody(req);
  stepStarted = logTrace(traceId, "read_body", stepStarted);
  const claim = typeof body.claim === "string" ? body.claim.trim() : "";
  if (!claim) {
    sendJson(res, 400, { status: "error", message: "claim is required" });
    return;
  }

  try {
    const cachedReport = getDemoVerifyReport(claim);
    if (cachedReport) {
      cachedReport.performance = {
        ...cachedReport.performance,
        trace_id: traceId,
        total_ms: nowMs() - totalStarted,
      };
      sendJson(res, 200, cachedReport);
      console.log(JSON.stringify({ trace_id: traceId, step: "demo_cache_response", ms: nowMs() - totalStarted }));
      return;
    }
    const ragContext = await retrieveRagContext(claim);
    stepStarted = logTrace(traceId, "rag_context", stepStarted, {
      evidence_count: ragContext?.evidence?.length || 0,
      school: ragContext?.school?.name || "",
    });
    const modelResults = await Promise.all([
      withTimeout(
        callGonkaModel(GONKA_MODEL_A, GONKA_MODEL_A_NAME, claim, ragContext),
        MODEL_TIMEOUT_MS,
        () => createTimeoutResult(GONKA_MODEL_A, GONKA_MODEL_A_NAME, MODEL_TIMEOUT_MS)
      ),
      withTimeout(
        callGonkaModel(GONKA_MODEL_B, GONKA_MODEL_B_NAME, claim, ragContext),
        MODEL_TIMEOUT_MS,
        () => createTimeoutResult(GONKA_MODEL_B, GONKA_MODEL_B_NAME, MODEL_TIMEOUT_MS)
      ),
    ]);
    stepStarted = logTrace(traceId, "models", stepStarted, {
      timeout_count: modelResults.filter((item) => item.timed_out).length,
      ok_count: modelResults.filter((item) => item.ok).length,
    });
    const report = mergeModelResults(claim, modelResults, ragContext);
    report.performance = {
      trace_id: traceId,
      total_ms: nowMs() - totalStarted,
      model_timeout_ms: MODEL_TIMEOUT_MS,
      timeout_count: modelResults.filter((item) => item.timed_out).length,
    };
    sendJson(res, 200, report);
    logTrace(traceId, "response_sent", totalStarted, { status: 200 });
    saveVerifyReport(report, body)
      .then((saveResult) => {
        console.log(JSON.stringify({
          trace_id: traceId,
          step: "save_report_async",
          saved: saveResult.saved,
          report_id: saveResult.id || null,
          error: saveResult.error || "",
        }));
      })
      .catch((error) => {
        console.warn(JSON.stringify({ trace_id: traceId, step: "save_report_async_error", error: error.message }));
      });
  } catch (error) {
    console.warn(JSON.stringify({ trace_id: traceId, step: "verify_error", ms: nowMs() - totalStarted, error: error.message }));
    sendJson(res, 500, { status: "error", message: error.message || "verify failed" });
  }
}

function pickAnswersByTopic(responses, matchers, limit = 3) {
  const matched = (responses || []).filter((item) => {
    const topic = item.questions?.topic || "";
    const text = item.questions?.text || "";
    return matchers.some((matcher) => topic.includes(matcher) || text.includes(matcher));
  });
  return matched.slice(0, limit).map((item) => item.answer).filter(Boolean);
}

function summarizeFeedback(answers, emptyText) {
  if (!answers.length) return emptyText;
  return answers
    .map((answer) => String(answer).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" / ")
    .slice(0, 120);
}

function buildComparePrompt(schools) {
  const compactSchools = schools.map((school) => ({
    name: school.name,
    found: school.found,
    current_rows: school.rows,
    rag_evidence: (school.evidence || []).slice(0, 6).map((item) => ({
      title: item.title,
      quote: String(item.quote || "").slice(0, 180),
      published_at: item.published_at || "",
    })),
  }));

  return [
    "你是高考志愿学校对比助手。",
    "请结合输入中的 RAG 学生反馈，以及你对高校公开常识的综合理解，生成学校对比表。",
    "重要要求：",
    "1. 只能输出 JSON，不要输出 Markdown。",
    "2. 你必须给每个字段生成可读答案，RAG 只是参考证据，不要直接复制“是/有/不是/暂无”这种短反馈。",
    "3. 如果 RAG 没有覆盖某字段，请用模型自身知识给出定性判断，不要写“暂无”“待接入”“需接入”。",
    "4. 录取位次、升学率等数字字段不能编造具体数字，但要给可操作判断，例如“模型综合：需按省份与专业组查近三年位次”。",
    "5. 住宿、交通、校园环境、学习氛围也要给完整判断；如果 RAG 不足，就用模型综合判断。",
    "6. 每个单元格尽量控制在 30 个中文以内。",
    "",
    "请返回这个 JSON 格式：",
    "{",
    '  "schools": [',
    "    {",
    '      "name": "学校名",',
    '      "summary": "该校适配建议",',
    '      "rows": {',
    '        "2025 录取位次": "模型综合：需按省份查近三年位次",',
    '        "优势专业": "模型综合：...",',
    '        "升学率": "模型综合：看就业质量报告与保研去向",',
    '        "城市机会": "模型综合：...",',
    '        "住宿条件": "RAG：...",',
    '        "交通便利": "RAG：...",',
    '        "校园环境": "RAG：...",',
    '        "学习氛围": "RAG：...",',
    '        "风险提示": "..."',
    "      }",
    "    }",
    "  ],",
    '  "quick_conclusions": ["结论1", "结论2", "结论3"]',
    "}",
    "",
    "输入数据：",
    JSON.stringify(compactSchools, null, 2),
  ].join("\n");
}

async function callCompareModel(model, displayName, schools) {
  if (!GONKA_API_KEY || GONKA_API_KEY.includes("这里填")) {
    return { ok: false, model, display_name: displayName, error: "GONKA_API_KEY is not configured" };
  }

  const response = await fetch(`${GONKA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GONKA_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: buildComparePrompt(schools) }],
      temperature: 0.25,
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    return { ok: false, model, display_name: displayName, error: `${response.status} ${rawText}` };
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return { ok: false, model, display_name: displayName, error: "model response is not valid JSON" };
  }

  const content = data.choices?.[0]?.message?.content || "";
  const parsed = parseModelJson(content);
  return {
    ok: true,
    model,
    display_name: displayName,
    schools: Array.isArray(parsed.schools) ? parsed.schools : [],
    quick_conclusions: Array.isArray(parsed.quick_conclusions) ? parsed.quick_conclusions : [],
    raw_content: content,
  };
}

function applyCompareModelResults(baseSchools, modelResults) {
  const validResults = modelResults.filter((item) => item.ok);
  if (!validResults.length) return baseSchools.map(applyCompareFallbackRows);

  return baseSchools.map((school) => {
    const modelSchools = validResults
      .map((result) => (result.schools || []).find((item) => item.name === school.name))
      .filter(Boolean);
    const mergedRows = { ...(school.rows || {}) };

    for (const modelSchool of modelSchools) {
      for (const [key, value] of Object.entries(modelSchool.rows || {})) {
        const current = String(mergedRows[key] || "");
        if (value && shouldUseModelCompareValue(current)) {
          mergedRows[key] = value;
        }
      }
    }

    const modelSummary = modelSchools.map((item) => item.summary).find(Boolean);
    return applyCompareFallbackRows({
      ...school,
      rows: mergedRows,
      summary: modelSummary || school.summary,
      model_compare: modelSchools,
    });
  });
}

function shouldUseModelCompareValue(current) {
  const text = String(current || "").trim();
  if (!text) return true;
  if (/待接入|暂无|需接入|待补充|待确认|暂无足够/.test(text)) return true;
  if (/^(是|有|不是|没有|否|是\s*\/\s*是|有\s*\/\s*有|不是\s*\/\s*不是)$/.test(text)) return true;
  if (text.length <= 6) return true;
  return true;
}

function applyCompareFallbackRows(school) {
  const rows = { ...(school.rows || {}) };
  const name = school.name || "";
  const province = school.province || "";
  const fallback = {
    "2025 录取位次": "模型综合：需按省份查近三年专业组位次",
    "优势专业": inferSchoolStrength(name),
    "升学率": "模型综合：看就业质量报告、保研与考研去向",
    "城市机会": inferCityOpportunity(name, province),
    "住宿条件": "模型综合：需结合具体校区，优先核验新老校区差异",
    "交通便利": "模型综合：看校区位置、地铁距离和通勤成本",
    "校园环境": "模型综合：看校区新旧、面积和生活配套",
    "学习氛围": "模型综合：看专业竞争强度、升学目标和学院差异",
    "风险提示": "模型综合：结论需再用官方数据和学生反馈交叉验证",
  };

  for (const [key, value] of Object.entries(fallback)) {
    const current = String(rows[key] || "");
    if (!current || /待接入|暂无|需接入|待补充|待确认/.test(current)) rows[key] = value;
  }

  return {
    ...school,
    rows,
    summary: school.summary || `${name} 已生成模型综合对比，后续应补充官方数据核验。`,
  };
}

function inferSchoolStrength(name) {
  if (name.includes("深圳大学")) return "模型综合：计算机、电子信息、设计与经管较受关注";
  if (name.includes("中山大学")) return "模型综合：医学、经管、法学、计算机等综合实力强";
  if (name.includes("华南师范大学")) return "模型综合：师范教育、心理学、计算机与文科方向";
  if (name.includes("华南理工")) return "模型综合：工科、建筑、材料、计算机方向";
  if (name.includes("暨南大学")) return "模型综合：新闻传播、经管、医学、国际化方向";
  return "模型综合：需结合学科评估、培养方案和就业报告判断";
}

function inferCityOpportunity(name, province) {
  if (name.includes("深圳")) return "模型综合：深圳科技产业集中，实习和就业机会强";
  if (name.includes("中山大学") || name.includes("华南师范") || name.includes("华南理工") || name.includes("暨南")) {
    return "模型综合：广州高校资源密集，城市机会较丰富";
  }
  if (province) return `模型综合：${province}，需结合所在城市产业与专业判断`;
  return "模型综合：看城市产业、实习半径和校友资源";
}

async function buildSchoolCompareItem(name) {
  const school = await findSchoolByName(name);
  if (!school) {
    return {
      name,
      found: false,
      summary: "数据库中暂未匹配到该学校，请确认学校全称。",
      rows: {
        "2025 录取位次": "待接入官方录取数据",
        "优势专业": "待接入官方专业数据",
        "升学率": "待接入官方就业/升学报告",
        "城市机会": "待接入官方所在地与产业数据",
        "住宿条件": "暂无学生反馈",
        "交通便利": "暂无学生反馈",
        "校园环境": "暂无学生反馈",
        "学习氛围": "暂无学生反馈",
        "风险提示": "学校未匹配，无法生成真实对比",
      },
      evidence: [],
    };
  }

  const { data: responses, error } = await supabase
    .from("responses")
    .select("id,answer,response_year,response_month,questions(text,topic)")
    .eq("school_id", school.id)
    .limit(40);
  if (error) throw new Error(`Supabase compare responses query failed: ${error.message}`);

  const dormitory = pickAnswersByTopic(responses, ["dorm", "宿舍", "寝室", "住宿"]);
  const transport = pickAnswersByTopic(responses, ["transport", "交通", "地铁", "位置", "校区"]);
  const environment = pickAnswersByTopic(responses, ["environment", "环境", "校园", "食堂", "生活"]);
  const study = pickAnswersByTopic(responses, ["study", "学习", "保研", "考研", "升学"]);
  const today = new Date().toISOString().slice(0, 10);

  return {
    name: school.name,
    found: true,
    summary: `${school.name} 已匹配 ${responses?.length || 0} 条学生反馈样本，体验类结论来自学生反馈，录取与政策类仍需官方数据补充。`,
    rows: {
      "2025 录取位次": "待接入省考试院/阳光高考数据",
      "优势专业": "待接入官方专业与学科数据",
      "升学率": "待接入就业质量报告",
      "城市机会": school.province ? `${school.province}，城市机会需结合具体城市与专业判断` : "待补充所在地数据",
      "住宿条件": summarizeFeedback(dormitory, "暂无足够住宿反馈"),
      "交通便利": summarizeFeedback(transport, "暂无足够交通反馈"),
      "校园环境": summarizeFeedback(environment, "暂无足够校园环境反馈"),
      "学习氛围": summarizeFeedback(study, "暂无足够学习氛围反馈"),
      "风险提示": "学生反馈具有主观性，需结合校区、年份和官方信息复核",
    },
    evidence: (responses || []).slice(0, 8).map((item) => ({
      id: `feedback-${item.id}`,
      type: "student_feedback",
      title: item.questions?.text || "学生反馈",
      publisher: "学生反馈数据库",
      quote: item.answer || "",
      published_at: item.response_year ? String(item.response_year) : "",
      fetched_at: today,
    })),
  };
}

async function handleSchoolCompare(req, res) {
  const traceId = `compare-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let stepStarted = nowMs();
  const totalStarted = stepStarted;
  const body = await readJsonBody(req);
  stepStarted = logTrace(traceId, "read_body", stepStarted);
  const schools = Array.isArray(body.schools) ? body.schools.filter(Boolean) : [];
  if (!schools.length) {
    sendJson(res, 400, { status: "error", message: "schools is required" });
    return;
  }
  if (!isSupabaseReady()) {
    sendJson(res, 500, { status: "error", message: "Supabase is not configured" });
    return;
  }

  const ragSchools = await Promise.all(schools.map((school) => buildSchoolCompareItem(school)));
  stepStarted = logTrace(traceId, "rag_schools", stepStarted, { school_count: ragSchools.length });

  const modelResults = await Promise.all([
    withTimeout(
      callCompareModel(GONKA_MODEL_A, GONKA_MODEL_A_NAME, ragSchools),
      COMPARE_MODEL_TIMEOUT_MS,
      () => ({ ok: false, model: GONKA_MODEL_A, display_name: GONKA_MODEL_A_NAME, error: `timeout after ${COMPARE_MODEL_TIMEOUT_MS}ms`, timed_out: true })
    ),
    withTimeout(
      callCompareModel(GONKA_MODEL_B, GONKA_MODEL_B_NAME, ragSchools),
      COMPARE_MODEL_TIMEOUT_MS,
      () => ({ ok: false, model: GONKA_MODEL_B, display_name: GONKA_MODEL_B_NAME, error: `timeout after ${COMPARE_MODEL_TIMEOUT_MS}ms`, timed_out: true })
    ),
  ]);
  stepStarted = logTrace(traceId, "models", stepStarted, {
    timeout_count: modelResults.filter((item) => item.timed_out).length,
    ok_count: modelResults.filter((item) => item.ok).length,
  });
  const mergedSchools = applyCompareModelResults(ragSchools, modelResults);
  const modelConclusions = modelResults
    .filter((item) => item.ok)
    .flatMap((item) => item.quick_conclusions || []);

  sendJson(res, 200, {
    status: "completed",
    source: "supabase_rag_plus_two_models",
    performance: {
      trace_id: traceId,
      total_ms: nowMs() - totalStarted,
      model_timeout_ms: COMPARE_MODEL_TIMEOUT_MS,
      timeout_count: modelResults.filter((item) => item.timed_out).length,
    },
    schools: mergedSchools,
    model_results: modelResults.map((item) => ({
      model: item.display_name || item.model,
      ok: item.ok,
      error: item.error || "",
    })),
    quick_conclusions: modelConclusions.length
      ? Array.from(new Set(modelConclusions)).slice(0, 3)
      : [
          "??????? Supabase RAG ????",
          "???????????????????",
          "??????????????????",
        ],
  });
  logTrace(traceId, "response_sent", totalStarted, { status: 200 });
}

function normalizeVerifyReportRow(row) {
  const report = row.report && typeof row.report === "object" ? row.report : {};
  return {
    id: String(row.id),
    claim: row.claim || report.claim || "未命名核验",
    truth_score: Number(row.truth_score || report.truth_score || 0),
    verdict: row.verdict || report.verdict || "待判断",
    summary: row.summary || report.summary || "",
    risk_tags: row.risk_tags || report.risk_tags || [],
    created_at: row.created_at,
    cloud_saved: true,
    report: {
      ...report,
      report_id: row.id,
      claim: row.claim || report.claim,
      truth_score: Number(row.truth_score || report.truth_score || 0),
      verdict: row.verdict || report.verdict,
      summary: row.summary || report.summary || "",
      risk_tags: row.risk_tags || report.risk_tags || [],
      evidence: row.evidence || report.evidence || [],
      conflicts: row.conflicts || report.conflicts || [],
      models: row.models || report.models || [],
      recognized: row.recognized || report.recognized || {},
      cloud_saved: true,
    },
  };
}

async function handleVerifyReports(req, res) {
  if (!isSupabaseReady()) {
    sendJson(res, 500, { status: "error", message: "Supabase is not configured" });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const keyword = (url.searchParams.get("q") || "").trim();
  const limit = Math.min(Number(url.searchParams.get("limit") || 30), 100);

  let query = supabase
    .from("verify_reports")
    .select("id,created_at,claim,status,truth_score,verdict,summary,risk_tags,evidence,conflicts,models,recognized,report")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (keyword) {
    query = query.or(`claim.ilike.%${keyword}%,verdict.ilike.%${keyword}%,summary.ilike.%${keyword}%`);
  }

  const { data, error } = await query;
  if (error) {
    sendJson(res, 500, { status: "error", message: error.message });
    return;
  }

  sendJson(res, 200, {
    status: "completed",
    source: "supabase.verify_reports",
    reports: (data || []).map(normalizeVerifyReportRow),
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "truth-verify-api",
      endpoints: ["GET /", "POST /api/verify", "GET /api/verify-reports", "POST /api/school-compare"],
      models: [GONKA_MODEL_A_NAME, GONKA_MODEL_B_NAME],
      model_ids: [GONKA_MODEL_A, GONKA_MODEL_B],
      has_gonka_key: Boolean(GONKA_API_KEY && !GONKA_API_KEY.includes("这里填")),
      has_supabase: isSupabaseReady(),
    });
    return;
  }

  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/truth-verify-demov2.html")) {
      sendStaticFile(res, "truth-verify-demov2.html", "text/html; charset=utf-8");
      return;
    }
    if (req.method === "GET" && req.url === "/truth-verify-api.js") {
      sendStaticFile(res, "truth-verify-api.js", "application/javascript; charset=utf-8");
      return;
    }
    if (req.method === "GET" && req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/verify-reports")) {
      await handleVerifyReports(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/verify") {
      await handleVerify(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/school-compare") {
      await handleSchoolCompare(req, res);
      return;
    }
    sendJson(res, 404, { status: "not_found", message: "Use POST /api/verify, GET /api/verify-reports or POST /api/school-compare" });
  } catch (error) {
    sendJson(res, 500, { status: "error", message: error.message || "server error" });
  }
});

server.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Verify endpoint: POST http://localhost:${PORT}/api/verify`);
  console.log(`Verify reports endpoint: GET http://localhost:${PORT}/api/verify-reports`);
  console.log(`School compare endpoint: POST http://localhost:${PORT}/api/school-compare`);
  console.log(`Model A: ${GONKA_MODEL_A_NAME} (${GONKA_MODEL_A})`);
  console.log(`Model B: ${GONKA_MODEL_B_NAME} (${GONKA_MODEL_B})`);
});
