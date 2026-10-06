import { AppError } from './errors.mjs';

const paceValues = new Set(['relaxed', 'balanced', 'intense']);
const riskValues = new Set(['low', 'medium', 'high']);

function text(value, field, maxLength = 500) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new AppError('PLANNER_RESPONSE_INVALID', `玩法策划结果缺少有效字段：${field}。`, 502);
  }
  return value.trim();
}

function textList(value, field, { min = 1, max = 6 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new AppError('PLANNER_RESPONSE_INVALID', `玩法策划结果中的 ${field} 数量不正确。`, 502);
  }
  return value.map((item, index) => text(item, `${field}[${index}]`, 240));
}

function parseModelJson(value) {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AppError('PLANNER_RESPONSE_INVALID', '玩法策划模型没有返回有效的结构化结果。', 502);
  }
}

export function normalizePlannerResult(raw, questionCount) {
  if (!raw || typeof raw !== 'object') {
    throw new AppError('PLANNER_RESPONSE_INVALID', '玩法策划模型返回了无效结果。', 502);
  }
  if (raw.kind === 'question') {
    if (questionCount >= 3) {
      throw new AppError('PLANNER_QUESTION_LIMIT', '已经完成三个关键问题，系统不能继续追问。', 502);
    }
    const options = textList(raw.question?.options, 'question.options', { min: 2, max: 4 });
    if (new Set(options).size !== options.length) {
      throw new AppError('PLANNER_RESPONSE_INVALID', '玩法策划问题包含重复选项。', 502);
    }
    return {
      kind: 'question',
      question: {
        id: `question-${questionCount + 1}`,
        text: text(raw.question?.text, 'question.text', 160),
        options,
        allowFreeText: true,
      },
    };
  }
  if (raw.kind !== 'proposals' || !Array.isArray(raw.proposals) || raw.proposals.length !== 3) {
    throw new AppError('PLANNER_RESPONSE_INVALID', '玩法策划模型必须返回一个问题或三个玩法提案。', 502);
  }

  const proposals = raw.proposals.map((proposal, index) => {
    const sessionLengthMinutes = Number(proposal.sessionLengthMinutes);
    if (!Number.isInteger(sessionLengthMinutes) || sessionLengthMinutes < 1 || sessionLengthMinutes > 3) {
      throw new AppError('PLANNER_RESPONSE_INVALID', '每个玩法提案的单局时长必须为 1 至 3 分钟。', 502);
    }
    if (!paceValues.has(proposal.pace) || !riskValues.has(proposal.implementationRisk)) {
      throw new AppError('PLANNER_RESPONSE_INVALID', '玩法提案的节奏或实现风险无效。', 502);
    }
    return {
      id: `proposal-${String.fromCharCode(97 + index)}`,
      name: text(proposal.name, `proposals[${index}].name`, 40),
      oneLiner: text(proposal.oneLiner, `proposals[${index}].oneLiner`, 120),
      playerRole: text(proposal.playerRole, `proposals[${index}].playerRole`, 80),
      goal: text(proposal.goal, `proposals[${index}].goal`, 160),
      coreLoop: textList(proposal.coreLoop, `proposals[${index}].coreLoop`, { min: 2, max: 5 }),
      controls: text(proposal.controls, `proposals[${index}].controls`, 120),
      successCondition: text(proposal.successCondition, `proposals[${index}].successCondition`, 160),
      failureCondition: text(proposal.failureCondition, `proposals[${index}].failureCondition`, 160),
      sessionLengthMinutes,
      pace: proposal.pace,
      visualDirection: text(proposal.visualDirection, `proposals[${index}].visualDirection`, 180),
      highlightMoment: text(proposal.highlightMoment, `proposals[${index}].highlightMoment`, 180),
      simplifications: textList(proposal.simplifications, `proposals[${index}].simplifications`, { min: 1, max: 4 }),
      implementationRisk: proposal.implementationRisk,
    };
  });

  if (new Set(proposals.map((proposal) => proposal.name)).size !== 3) {
    throw new AppError('PLANNER_RESPONSE_INVALID', '三个玩法提案必须使用不同名称。', 502);
  }
  const mechanics = proposals.map((proposal) =>
    `${proposal.goal}|${proposal.coreLoop.join('|')}|${proposal.successCondition}|${proposal.failureCondition}`
      .replace(/\s+/g, '')
      .toLowerCase(),
  );
  if (new Set(mechanics).size !== 3) {
    throw new AppError('PLANNER_RESPONSE_INVALID', '三个提案必须具有实质不同的玩法规则。', 502);
  }
  return { kind: 'proposals', proposals };
}

function systemPrompt() {
  return `你是 IfPlay 的游戏创意导演，服务没有游戏设计经验的中文用户。

你的任务是把模糊想法变成适合浏览器和手机、单局 1 至 3 分钟的轻量游戏方向。

必须只返回 JSON，不要使用 Markdown。

如果仍缺少一个会显著改变核心玩法的关键信息，并且 questionCount 小于 3，返回：
{"kind":"question","question":{"text":"一个简短问题","options":["2 至 4 个易懂选项"]}}

如果信息足够，或者 mustPropose 为 true，必须返回：
{"kind":"proposals","proposals":[三个提案]}

每个提案必须包含：name、oneLiner、playerRole、goal、coreLoop、controls、successCondition、failureCondition、sessionLengthMinutes、pace、visualDirection、highlightMoment、simplifications、implementationRisk。

字段约束：
- coreLoop 是 2 至 5 个动作组成的字符串数组。
- sessionLengthMinutes 只能是 1、2 或 3。
- pace 只能是 relaxed、balanced 或 intense。
- implementationRisk 只能是 low、medium 或 high。
- simplifications 是 1 至 4 个字符串组成的数组。
- 三个提案必须在核心动作、目标结构、失败规则或节奏上存在实质差异。仅替换名称、题材或画风不算差异。
- 画面方向应描述色彩、构图、材质和氛围，不得声称已经生成游戏截图。
- 不要提出大型 3D、实时多人、持续联网或重度后端方案。`;
}

export async function planGame({ idea, clarifications, questionCount, mustPropose }, options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new AppError('PLANNER_NOT_CONFIGURED', 'DeepSeek 玩法策划服务尚未配置。', 503);
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
        temperature: 0.7,
        max_tokens: 2200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt() },
          {
            role: 'user',
            content: JSON.stringify({ idea, clarifications, questionCount, mustPropose }),
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new AppError('PLANNER_TIMEOUT', '玩法策划超时，请重试。', 504);
    }
    throw new AppError('PLANNER_UNAVAILABLE', '暂时无法连接玩法策划服务，请稍后重试。', 502);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new AppError('PLANNER_UPSTREAM_ERROR', `玩法策划服务返回错误（${response.status}）。`, 502);
  }
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  const result = normalizePlannerResult(parseModelJson(text(content, 'choices[0].message.content', 30_000)), questionCount);
  return {
    ...result,
    provider: { model, usage: body.usage ?? null },
  };
}
