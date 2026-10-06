import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function generateDemo({ project, task, outputDir }) {
  await mkdir(outputDir, { recursive: true });
  const idea = escapeHtml(project.idea);
  const instruction = escapeHtml(task.instruction);
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IfPlay 本地演示</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12141b;color:#fff;font-family:system-ui}
main{width:min(720px,90vw);padding:32px;border:1px solid #34394a;border-radius:24px;background:#1b1f2a}
button{font:inherit;padding:12px 18px;border:0;border-radius:12px;background:#72e3a6;color:#102018;cursor:pointer}
#score{font-size:64px;font-weight:800;margin:24px 0}.notice{color:#ffcf70}</style></head>
<body><main><p class="notice">开发模式演示，不是 AI 真实生成结果</p><h1>${idea}</h1><p>${instruction}</p>
<div id="score">0</div><button id="play">点击得分</button><p>目标：在 10 秒内尽可能多地点击。</p></main>
<script>let score=0;document.querySelector('#play').onclick=()=>{score+=1;document.querySelector('#score').textContent=score}</script></body></html>`;
  await writeFile(path.join(outputDir, 'index.html'), html);
  return { generatorMode: 'demo', outputPath: path.join(outputDir, 'index.html') };
}

async function generateWithOpenGame({ project, task, outputDir }) {
  if (process.env.IFPLAY_ALLOW_UNSANDBOXED_OPENGAME !== 'true') {
    throw new AppError(
      'OPENGAME_SANDBOX_REQUIRED',
      '当前 OpenGame 未运行在生产级沙箱中，已拒绝真实生成。',
      503,
    );
  }
  await mkdir(outputDir, { recursive: true });
  const upstream = path.join(sourceRoot, 'vendor', 'opengame');
  const prompt = `${project.idea}\n\n修改或补充要求：${task.instruction}`;
  const gameAssets = path.join(upstream, 'agent-test');
  await new Promise((resolve, reject) => {
    const child = spawn(
      'npm',
      [
        '--prefix',
        upstream,
        'run',
        'start',
        '--',
        '-p',
        prompt,
        '--approval-mode',
        'auto-edit',
        '--telemetry=false',
      ],
      {
        cwd: outputDir,
        env: {
          ...process.env,
          QWEN_WORKING_DIR: outputDir,
          GAME_TEMPLATES_DIR: path.join(gameAssets, 'templates'),
          GAME_DOCS_DIR: path.join(gameAssets, 'docs'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new AppError('OPENGAME_FAILED', stderr || `OpenGame 退出码 ${code}`, 502));
    });
  });
  return { generatorMode: 'opengame', outputPath: path.join(outputDir, 'index.html') };
}

export async function generateGame(input) {
  const mode = process.env.IFPLAY_GENERATOR_MODE ?? 'demo';
  if (mode === 'demo') return generateDemo(input);
  if (mode === 'opengame') return generateWithOpenGame(input);
  throw new AppError('GENERATOR_MODE_INVALID', `未知生成模式：${mode}`, 500);
}
