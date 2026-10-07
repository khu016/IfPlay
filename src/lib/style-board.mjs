import { AppError } from './errors.mjs';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const POLL_INTERVAL_MS = 1200;
const POLL_TIMEOUT_MS = 90_000;

function imageConfig() {
  return {
    apiKey: process.env.OPENGAME_IMAGE_API_KEY,
    baseUrl: (process.env.OPENGAME_IMAGE_BASE_URL ?? 'https://dashscope.aliyuncs.com').replace(/\/$/, ''),
    model: process.env.OPENGAME_IMAGE_MODEL ?? 'wanx2.1-t2i-turbo',
  };
}

function styleBoardPrompt(proposals) {
  const directions = proposals.map((proposal, index) =>
    `${String.fromCharCode(65 + index)}区：${proposal.visualDirection}`,
  );
  return [
    '一张正方形网页小游戏概念风格板，画面严格分成三个等宽竖向分区，三个分区边界清晰。',
    ...directions,
    '三个分区采用一致的游戏概念美术展示尺度，各自呈现代表性的场景、角色轮廓、色彩和光影。',
    '这不是游戏截图，不要界面、按钮、文字、字母、数字、标志、水印和边框。画面清楚，适合用作视觉方向选择。',
  ].join(' ');
}

async function apiJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new AppError('STYLE_PROVIDER_INVALID', '图片服务返回了无法识别的结果。', 502);
  }
  if (!response.ok) {
    const message = body?.message ?? body?.output?.message ?? '图片服务暂时不可用。';
    throw new AppError('STYLE_PROVIDER_FAILED', message, 502);
  }
  return body;
}

function assertDownloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('STYLE_IMAGE_URL_INVALID', '图片服务没有返回有效图片地址。', 502);
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.aliyuncs.com')) {
    throw new AppError('STYLE_IMAGE_URL_INVALID', '图片服务返回了不受信任的图片地址。', 502);
  }
  return url;
}

async function downloadImage(imageUrl) {
  const url = assertDownloadUrl(imageUrl);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new AppError('STYLE_IMAGE_DOWNLOAD_FAILED', '参考图已生成，但下载失败。', 502);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) {
    throw new AppError('STYLE_IMAGE_INVALID', '图片服务返回的文件格式不正确。', 502);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new AppError('STYLE_IMAGE_INVALID', '参考图大小不符合要求。', 502);
  }
  return { buffer, contentType: contentType.split(';', 1)[0] };
}

export async function generateStyleBoard({ proposals }) {
  const config = imageConfig();
  if (!config.apiKey) {
    throw new AppError('STYLE_PROVIDER_NOT_CONFIGURED', '万相图片服务尚未配置。', 503);
  }
  if (!Array.isArray(proposals) || proposals.length !== 3) {
    throw new AppError('STYLE_PROPOSALS_INVALID', '需要三个玩法方向才能生成参考图。', 409);
  }

  const createUrl = `${config.baseUrl}/api/v1/services/aigc/text2image/image-synthesis`;
  const created = await apiJson(createUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      'x-dashscope-async': 'enable',
    },
    body: JSON.stringify({
      model: config.model,
      input: {
        prompt: styleBoardPrompt(proposals),
        negative_prompt: '文字，字母，数字，按钮，界面，水印，标志，模糊，重复构图',
      },
      parameters: { prompt_extend: false, size: '1024*1024', n: 1 },
    }),
  });
  const taskId = created?.output?.task_id;
  if (!taskId) {
    throw new AppError('STYLE_TASK_INVALID', '图片服务没有返回任务编号。', 502);
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let completed;
  while (Date.now() < deadline) {
    const task = await apiJson(`${config.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    const status = task?.output?.task_status;
    if (status === 'SUCCEEDED') {
      completed = task;
      break;
    }
    if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(status)) {
      throw new AppError('STYLE_TASK_FAILED', task?.output?.message ?? '参考图生成失败。', 502);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (!completed) {
    throw new AppError('STYLE_TASK_TIMEOUT', '参考图生成超时，请稍后重试。', 504);
  }

  const imageUrl = completed?.output?.results?.[0]?.url;
  const image = await downloadImage(imageUrl);
  return {
    ...image,
    provider: {
      provider: 'tongyi',
      model: config.model,
      taskId,
      usage: completed.usage ?? completed.output?.task_metrics ?? null,
    },
  };
}
