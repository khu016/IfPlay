const storageKey = 'ifplay.project';

const elements = {
  serviceState: document.querySelector('#service-state'),
  ideaForm: document.querySelector('#idea-form'),
  idea: document.querySelector('#idea'),
  ideaHelp: document.querySelector('#idea-help'),
  createButton: document.querySelector('#create-button'),
  planCard: document.querySelector('#plan-card'),
  planIdea: document.querySelector('#plan-idea'),
  editIdeaButton: document.querySelector('#edit-idea-button'),
  generateButton: document.querySelector('#generate-button'),
  modifyPanel: document.querySelector('#modify-panel'),
  modifyForm: document.querySelector('#modify-form'),
  instruction: document.querySelector('#instruction'),
  modifyButton: document.querySelector('#modify-button'),
  message: document.querySelector('#message'),
  taskState: document.querySelector('#task-state'),
  taskStateText: document.querySelector('#task-state-text'),
  emptyPreview: document.querySelector('#empty-preview'),
  gameFrame: document.querySelector('#game-frame'),
  versionStrip: document.querySelector('#version-strip'),
  versionNumber: document.querySelector('#version-number'),
  generatorLabel: document.querySelector('#generator-label'),
};

let session = loadSession();
let ideaTouched = false;

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) ?? null;
  } catch {
    localStorage.removeItem(storageKey);
    return null;
  }
}

function saveSession(value) {
  session = value;
  localStorage.setItem(storageKey, JSON.stringify(value));
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('content-type', 'application/json');
  if (session?.token) headers.set('x-project-token', session.token);
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? '请求没有完成，请稍后再试。');
    error.code = body?.error?.code ?? 'REQUEST_FAILED';
    throw error;
  }
  return body;
}

function setButtonState(button, state) {
  button.dataset.state = state;
  button.disabled = state === 'loading';
}

function showMessage(message) {
  elements.message.textContent = message;
  elements.message.hidden = false;
}

function clearMessage() {
  elements.message.hidden = true;
  elements.message.textContent = '';
}

function validateIdea() {
  const value = elements.idea.value.trim();
  const valid = value.length >= 4 && value.length <= 2000;
  elements.idea.setAttribute('aria-invalid', String(!valid));
  if (!valid && ideaTouched) {
    elements.ideaHelp.dataset.state = 'error';
    elements.ideaHelp.textContent = '想法至少写 4 个字。可以先写题材和玩家要做的事。';
  } else {
    delete elements.ideaHelp.dataset.state;
    elements.ideaHelp.textContent = '写题材、玩家要做什么，或者只写一个你喜欢的画面。';
  }
  return valid;
}

function showPlan(project) {
  elements.ideaForm.hidden = true;
  elements.planCard.hidden = false;
  elements.planIdea.textContent = project.idea;
}

function showTask(status, stage) {
  const labels = {
    queued: '已进入队列',
    running: stage === 'generating' ? '正在生成游戏' : '正在处理',
    succeeded: '新版本已完成',
    failed: '生成没有完成',
  };
  elements.taskState.hidden = false;
  elements.taskStateText.textContent = labels[status] ?? '正在处理';
  elements.taskState.querySelector('.task-state__spinner').hidden = !['queued', 'running'].includes(status);
}

async function createGeneration(instruction, button) {
  clearMessage();
  setButtonState(button, 'loading');
  showTask('queued', 'queued');
  try {
    const { task } = await api(`/api/projects/${session.projectId}/generations`, {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    });
    await pollTask(task.id);
    setButtonState(button, 'success');
    window.setTimeout(() => setButtonState(button, 'idle'), 900);
  } catch (error) {
    setButtonState(button, 'error');
    showMessage(`${error.message} 请调整要求后再试。`);
    showTask('failed', 'failed');
  }
}

async function pollTask(taskId) {
  for (;;) {
    const { task } = await api(`/api/tasks/${taskId}`);
    showTask(task.status, task.stage);
    if (task.status === 'succeeded') {
      await loadPlayableVersion();
      return;
    }
    if (task.status === 'failed') {
      throw new Error(task.error?.message ?? '生成任务失败。');
    }
    await new Promise((resolve) => window.setTimeout(resolve, 750));
  }
}

async function loadPlayableVersion() {
  const previewResponse = await fetch(`/api/projects/${session.projectId}/preview`, {
    headers: { 'x-project-token': session.token },
  });
  if (!previewResponse.ok) throw new Error('试玩内容暂时无法打开。请重新生成。');
  elements.gameFrame.srcdoc = await previewResponse.text();
  elements.gameFrame.hidden = false;
  elements.emptyPreview.hidden = true;

  const { versions } = await api(`/api/projects/${session.projectId}/versions`);
  const current = versions.at(-1);
  if (current) {
    elements.versionNumber.textContent = `v${current.number}`;
    elements.generatorLabel.textContent =
      current.generatorMode === 'demo' ? '开发演示 · 非真实 AI 生成' : 'OpenGame 生成';
    elements.versionStrip.hidden = false;
  }
  elements.ideaForm.hidden = true;
  elements.planCard.hidden = true;
  elements.modifyPanel.hidden = false;
}

async function restoreProject() {
  if (!session?.projectId || !session?.token) return;
  try {
    const { project } = await api(`/api/projects/${session.projectId}`);
    elements.idea.value = project.idea;
    if (project.currentVersionId) await loadPlayableVersion();
    else showPlan(project);
  } catch (error) {
    localStorage.removeItem(storageKey);
    session = null;
    if (error.code !== 'PROJECT_NOT_FOUND') showMessage(error.message);
  }
}

async function checkService() {
  try {
    const health = await api('/api/health');
    elements.serviceState.dataset.state = 'ready';
    elements.serviceState.querySelector('span:last-child').textContent =
      health.generatorMode === 'demo' ? '开发模式' : 'OpenGame 已连接';
  } catch {
    elements.serviceState.dataset.state = 'error';
    elements.serviceState.querySelector('span:last-child').textContent = '后端未连接';
  }
}

elements.idea.addEventListener('blur', () => {
  ideaTouched = true;
  validateIdea();
});

elements.idea.addEventListener('input', () => {
  if (ideaTouched) validateIdea();
});

document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => {
    elements.idea.value = button.dataset.prompt;
    ideaTouched = true;
    validateIdea();
    elements.idea.focus();
  });
});

elements.ideaForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  ideaTouched = true;
  if (!validateIdea()) {
    elements.idea.focus();
    return;
  }
  clearMessage();
  setButtonState(elements.createButton, 'loading');
  try {
    const created = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ idea: elements.idea.value.trim() }),
    });
    saveSession({ projectId: created.project.id, token: created.token });
    showPlan(created.project);
    setButtonState(elements.createButton, 'success');
  } catch (error) {
    setButtonState(elements.createButton, 'error');
    showMessage(`${error.message} 检查后端连接后再试。`);
  }
});

elements.editIdeaButton.addEventListener('click', () => {
  elements.planCard.hidden = true;
  elements.ideaForm.hidden = false;
  elements.idea.focus();
});

elements.generateButton.addEventListener('click', () => {
  createGeneration('根据已确认的想法生成第一版可玩的网页游戏。', elements.generateButton);
});

elements.modifyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const instruction = elements.instruction.value.trim();
  if (instruction.length < 2) {
    elements.instruction.setAttribute('aria-invalid', 'true');
    showMessage('修改要求至少写 2 个字。请说明你希望哪里发生变化。');
    elements.instruction.focus();
    return;
  }
  elements.instruction.setAttribute('aria-invalid', 'false');
  await createGeneration(instruction, elements.modifyButton);
  if (elements.modifyButton.dataset.state !== 'error') elements.instruction.value = '';
});

await checkService();
await restoreProject();
