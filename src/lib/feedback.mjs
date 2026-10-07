import { AppError } from './errors.mjs';

const categories = new Set(['visual', 'pace', 'controls', 'rules', 'feedback']);
const contractFields = new Set(['coreLoop', 'successCondition', 'failureCondition', 'visualDirection']);

function text(value, field, maxLength = 500) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new AppError('FEEDBACK_RESPONSE_INVALID', `修改建议缺少有效字段：${field}。`, 502);
  }
  return value.trim();
}

function textList(value, field, { min = 1, max = 5 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new AppError('FEEDBACK_RESPONSE_INVALID', `修改建议中的 ${field} 数量不正确。`, 502);
  }
  return value.map((item, index) => text(item, `${field}[${index}]`, 240));
}

function parseModelJson(value) {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AppError('FEEDBACK_RESPONSE_INVALID', '修改分析模型没有返回有效的结构化结果。', 502);
  }
}

export function normalizeFeedbackAnalysis(raw, hasContract = true) {
  if (!raw || typeof raw !== 'object' || !categories.has(raw.category)) {
    throw new AppError('FEEDBACK_RESPONSE_INVALID', '修改分析模型返回了无效结果。', 502);
  }
  const touchesContract = hasContract && raw.touchesContract === true;
  const touchedFields = Array.isArray(raw.touchedFields)
    ? [...new Set(raw.touchedFields.filter((field) => contractFields.has(field)))]
    : [];
  if (touchesContract && touchedFields.length === 0) {
    throw new AppError('FEEDBACK_RESPONSE_INVALID', '修改触碰玩法合同，但没有说明触碰字段。', 502);
  }
  return {
    summary: text(raw.summary, 'summary', 120),
    category: raw.category,
    changes: textList(raw.changes, 'changes', { min: 1, max: 4 }),
    preserved: textList(raw.preserved, 'preserved', { min: 2, max: 5 }),
    touchesContract,
    touchedFields: touchesContract ? touchedFields : [],
    instruction: text(raw.instruction, 'instruction', 1400),
    estimatedCost: '1 次修改任务；人民币金额待供应商账单核对',
  };
}

function systemPrompt() {
  return `你是 IfPlay 的试玩诊断员。用户试玩一个已经生成的网页小游戏后，会描述哪里不对。

你的任务是把感受翻译成边界清楚、可以执行的修改计划，并保护用户没有点名的内容。

必须只返回 JSON，不要使用 Markdown：
{"summary":"一句话修改摘要","category":"visual|pace|controls|rules|feedback","changes":["1至4项具体修改"],"preserved":["2至5项明确保持不变的内容"],"touchesContract":false,"touchedFields":[],"instruction":"交给游戏开发 Agent 的完整修改要求"}

规则：
- 默认只改变用户明确点名的部分，不得顺手重做其他功能。
- 只有用户明确要求改变核心循环、成功条件、失败条件或整体视觉方向时，touchesContract 才为 true。
- touchedFields 只能使用 coreLoop、successCondition、failureCondition、visualDirection。
- “画面不像所选方向”表示修复实现偏差，不是改变 visualDirection，因此 touchesContract 为 false。
- “太难”“节奏太慢”“操作不跟手”“奖励不明显”“不知道该做什么”默认不改变合同。
- instruction 必须同时写清楚要改和保持不变的内容，不要承诺未经验证的结果。
- 不增加大型 3D、实时多人、持续联网世界或重度后端功能。`;
}

export async function analyzeFeedback({ feedback, presetCategory, project, contract }, options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new AppError('FEEDBACK_ANALYZER_NOT_CONFIGURED', 'DeepSeek 修改分析服务尚未配置。', 503);
  }
  const baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = options.model ?? process.env.OPENAI_MODEL ?? 'deepseek-chat';
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt() },
          {
            role: 'user',
            content: JSON.stringify({
              gameIdea: project.idea,
              currentContract: contract,
              presetCategory,
              feedback,
            }),
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new AppError('FEEDBACK_ANALYZER_TIMEOUT', '修改分析超时，请重试。', 504);
    }
    throw new AppError('FEEDBACK_ANALYZER_UNAVAILABLE', '暂时无法连接修改分析服务，请稍后重试。', 502);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new AppError('FEEDBACK_ANALYZER_UPSTREAM_ERROR', `修改分析服务返回错误（${response.status}）。`, 502);
  }
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  const result = normalizeFeedbackAnalysis(
    parseModelJson(text(content, 'choices[0].message.content', 20_000)),
    Boolean(contract),
  );
  return {
    ...result,
    provider: { model, usage: body.usage ?? null },
  };
}
