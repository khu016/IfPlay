const storageKey = 'ifplay.project';

const elements = {
  serviceState: document.querySelector('#service-state'),
  ideaForm: document.querySelector('#idea-form'),
  idea: document.querySelector('#idea'),
  ideaHelp: document.querySelector('#idea-help'),
  createButton: document.querySelector('#create-button'),
  questionPanel: document.querySelector('#question-panel'),
  questionCount: document.querySelector('#question-count'),
  questionCopy: document.querySelector('#question-copy'),
  answerOptions: document.querySelector('#answer-options'),
  answerForm: document.querySelector('#answer-form'),
  customAnswer: document.querySelector('#custom-answer'),
  answerButton: document.querySelector('#answer-button'),
  planCard: document.querySelector('#plan-card'),
  planTitle: document.querySelector('#plan-title'),
  planIdea: document.querySelector('#plan-idea'),
  planGoal: document.querySelector('#plan-goal'),
  planControls: document.querySelector('#plan-controls'),
  planDuration: document.querySelector('#plan-duration'),
  planLoop: document.querySelector('#plan-loop'),
  editIdeaButton: document.querySelector('#edit-idea-button'),
  reselectProposalButton: document.querySelector('#reselect-proposal-button'),
  generateButton: document.querySelector('#generate-button'),
  proposalBoard: document.querySelector('#proposal-board'),
  proposalList: document.querySelector('#proposal-list'),
  proposalSelectionHelp: document.querySelector('#proposal-selection-help'),
  confirmProposalButton: document.querySelector('#confirm-proposal-button'),
  styleBoard: document.querySelector('#style-board'),
  styleBoardLoading: document.querySelector('#style-board-loading'),
  styleBoardFigure: document.querySelector('#style-board-figure'),
  styleBoardImage: document.querySelector('#style-board-image'),
  styleOptions: document.querySelector('#style-options'),
  styleSelectionHelp: document.querySelector('#style-selection-help'),
  retryStyleButton: document.querySelector('#retry-style-button'),
  confirmStyleButton: document.querySelector('#confirm-style-button'),
  contractBoard: document.querySelector('#contract-board'),
  contractRole: document.querySelector('#contract-role'),
  contractGoal: document.querySelector('#contract-goal'),
  contractControls: document.querySelector('#contract-controls'),
  contractDuration: document.querySelector('#contract-duration'),
  contractLoop: document.querySelector('#contract-loop'),
  contractEnding: document.querySelector('#contract-ending'),
  contractVisual: document.querySelector('#contract-visual'),
  contractLocked: document.querySelector('#contract-locked'),
  contractBudget: document.querySelector('#contract-budget'),
  contractAcceptance: document.querySelector('#contract-acceptance'),
  changeStyleButton: document.querySelector('#change-style-button'),
  confirmContractButton: document.querySelector('#confirm-contract-button'),
  modifyPanel: document.querySelector('#modify-panel'),
  feedbackPresets: document.querySelector('#feedback-presets'),
  modifyForm: document.querySelector('#modify-form'),
  instruction: document.querySelector('#instruction'),
  modifyButton: document.querySelector('#modify-button'),
  changePlan: document.querySelector('#change-plan'),
  changePlanCategory: document.querySelector('#change-plan-category'),
  changePlanSummary: document.querySelector('#change-plan-summary'),
  changePlanChanges: document.querySelector('#change-plan-changes'),
  changePlanPreserved: document.querySelector('#change-plan-preserved'),
  contractImpact: document.querySelector('#contract-impact'),
  changePlanCost: document.querySelector('#change-plan-cost'),
  editFeedbackButton: document.querySelector('#edit-feedback-button'),
  confirmChangeButton: document.querySelector('#confirm-change-button'),
  message: document.querySelector('#message'),
  previewTitle: document.querySelector('#preview-title'),
  previewStage: document.querySelector('#preview-stage'),
  taskState: document.querySelector('#task-state'),
  taskStateText: document.querySelector('#task-state-text'),
  emptyPreview: document.querySelector('#empty-preview'),
  gameFrame: document.querySelector('#game-frame'),
  versionStrip: document.querySelector('#version-strip'),
  versionNumber: document.querySelector('#version-number'),
  generatorLabel: document.querySelector('#generator-label'),
};

let session = loadSession();
let currentProject = null;
let currentPlanning = null;
let selectedProposalId = null;
let selectedStyleId = null;
let styleBoardObjectUrl = null;
let selectedFeedbackCategory = 'custom';
let currentChangePlan = null;
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

function setEmptyPreview(title, detail) {
  elements.emptyPreview.querySelector('p').textContent = title;
  elements.emptyPreview.querySelector('small').textContent = detail;
}

function showPreviewPlaceholder(title = '你的游戏会出现在这里', detail = '确认玩法后生成第一版，再直接试玩。') {
  elements.previewTitle.textContent = '你的游戏会出现在这里';
  hidePreviewFlowPanels();
  elements.previewStage.hidden = false;
  elements.emptyPreview.hidden = false;
  elements.gameFrame.hidden = true;
  elements.versionStrip.hidden = true;
  setEmptyPreview(title, detail);
}

function hidePreviewFlowPanels() {
  elements.proposalBoard.hidden = true;
  elements.styleBoard.hidden = true;
  elements.contractBoard.hidden = true;
}

function hideCreationPanels() {
  elements.ideaForm.hidden = true;
  elements.questionPanel.hidden = true;
  elements.planCard.hidden = true;
  elements.modifyPanel.hidden = true;
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

function paceLabel(pace) {
  return { relaxed: '舒缓', balanced: '均衡', intense: '紧张' }[pace] ?? pace;
}

function withoutFinalPunctuation(value) {
  return value.replace(/[。！？.!?]+$/u, '');
}

function selectedProposal() {
  return currentPlanning?.proposals?.find((proposal) => proposal.id === selectedProposalId) ?? null;
}

function renderCoreLoop(list, items) {
  list.replaceChildren();
  items.forEach((item, index) => {
    const element = document.createElement('li');
    if (list.classList.contains('core-loop')) {
      const number = document.createElement('span');
      number.className = 'core-loop__number';
      number.setAttribute('aria-hidden', 'true');
      number.textContent = String(index + 1);
      const copy = document.createElement('span');
      copy.textContent = item;
      element.append(number, copy);
    } else {
      element.textContent = item;
    }
    list.append(element);
  });
}

function renderSimpleList(list, items) {
  list.replaceChildren();
  items.forEach((item) => {
    const element = document.createElement('li');
    element.textContent = item;
    list.append(element);
  });
}

function categoryLabel(category) {
  return {
    visual: '画面',
    pace: '节奏',
    controls: '操作',
    rules: '规则',
    feedback: '反馈感',
  }[category] ?? '自定义';
}

function contractFieldLabel(field) {
  return {
    coreLoop: '核心循环',
    successCondition: '成功条件',
    failureCondition: '失败条件',
    visualDirection: '整体视觉方向',
  }[field] ?? field;
}

function showFeedbackComposer() {
  currentChangePlan = null;
  elements.feedbackPresets.hidden = false;
  elements.modifyForm.hidden = false;
  elements.changePlan.hidden = true;
}

function showChangePlan(plan) {
  currentChangePlan = plan;
  elements.feedbackPresets.hidden = true;
  elements.modifyForm.hidden = true;
  elements.changePlan.hidden = false;
  elements.changePlanCategory.textContent = categoryLabel(plan.category);
  elements.changePlanSummary.textContent = plan.summary;
  renderSimpleList(elements.changePlanChanges, plan.changes);
  renderSimpleList(elements.changePlanPreserved, plan.preserved);
  elements.contractImpact.dataset.impact = plan.touchesContract ? 'change' : 'preserve';
  elements.contractImpact.textContent = plan.touchesContract
    ? `这会改变玩法合同中的${plan.touchedFields.map(contractFieldLabel).join('、')}，确认即代表重新确认这些规则。`
    : '这次不改变核心循环、结束条件和整体视觉方向。';
  elements.changePlanCost.textContent = plan.estimatedCost;
  elements.confirmChangeButton.textContent = plan.touchesContract
    ? '确认合同变更并生成'
    : '确认修改并生成';
}

function showPlan(project, proposal) {
  hideCreationPanels();
  elements.planCard.hidden = false;
  elements.planTitle.textContent = proposal.name;
  elements.planIdea.textContent = proposal.oneLiner;
  elements.planGoal.textContent = proposal.goal;
  elements.planControls.textContent = proposal.controls;
  elements.planDuration.textContent = `${proposal.sessionLengthMinutes} 分钟 · ${paceLabel(proposal.pace)}节奏`;
  renderCoreLoop(elements.planLoop, proposal.coreLoop);
  selectedProposalId = proposal.id;
  const confirmed = currentPlanning?.gameContract?.status === 'confirmed';
  elements.generateButton.disabled = !confirmed;
  elements.generateButton.textContent = confirmed ? '生成第一版游戏' : '确认玩法合同后生成';
}

function setPlanningBusy(busy, text = 'AI 正在整理玩法') {
  elements.taskState.hidden = !busy;
  elements.taskStateText.textContent = text;
  elements.taskState.querySelector('.task-state__spinner').hidden = !busy;
  elements.answerOptions.querySelectorAll('button').forEach((button) => {
    button.disabled = busy;
  });
  setButtonState(elements.answerButton, busy ? 'loading' : 'idle');
}

function showQuestion(planning) {
  hideCreationPanels();
  elements.questionPanel.hidden = false;
  hidePreviewFlowPanels();
  elements.previewStage.hidden = false;
  elements.emptyPreview.hidden = false;
  elements.gameFrame.hidden = true;
  elements.versionStrip.hidden = true;
  elements.previewTitle.textContent = '先把关键选择说清楚';
  setEmptyPreview('不用一次想得很完整。', 'AI 最多问三个真正影响玩法的问题，不会反复盘问细节。');

  const question = planning.pendingQuestion;
  elements.questionCount.textContent = `问题 ${planning.clarifications.length + 1} / 最多 3 个`;
  elements.questionCopy.textContent = question.text;
  elements.answerOptions.replaceChildren();
  question.options.forEach((option) => {
    const button = document.createElement('button');
    button.className = 'answer-option';
    button.type = 'button';
    button.textContent = option;
    button.addEventListener('click', () => continuePlanning(option));
    elements.answerOptions.append(button);
  });
  elements.customAnswer.value = '';
  elements.customAnswer.removeAttribute('aria-invalid');
}

function createFact(term, description) {
  const wrapper = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = term;
  dd.textContent = description;
  wrapper.append(dt, dd);
  return wrapper;
}

function createProposalOption(proposal, index) {
  const label = document.createElement('label');
  label.className = 'proposal-option';

  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'proposal';
  input.value = proposal.id;
  input.checked = proposal.id === selectedProposalId;
  input.addEventListener('change', () => {
    selectedProposalId = proposal.id;
    elements.confirmProposalButton.disabled = false;
    elements.proposalSelectionHelp.textContent = `已选择“${proposal.name}”。`;
    elements.proposalList.querySelectorAll('.proposal-option').forEach((option) => {
      const pick = option.querySelector('.proposal-option__pick');
      pick.textContent = option.querySelector('input').checked ? '已选择' : '选择方向';
    });
  });

  const body = document.createElement('span');
  body.className = 'proposal-option__body';
  const top = document.createElement('span');
  top.className = 'proposal-option__top';
  const letter = document.createElement('span');
  letter.className = 'proposal-option__letter';
  letter.textContent = String.fromCharCode(65 + index);
  const pick = document.createElement('span');
  pick.className = 'proposal-option__pick';
  pick.textContent = input.checked ? '已选择' : '选择方向';
  top.append(letter, pick);

  const title = document.createElement('h4');
  title.textContent = proposal.name;
  const oneLiner = document.createElement('p');
  oneLiner.className = 'proposal-option__one-liner';
  oneLiner.textContent = proposal.oneLiner;

  const facts = document.createElement('dl');
  facts.className = 'proposal-option__facts';
  facts.append(
    createFact('玩家目标', proposal.goal),
    createFact(
      '怎样结束',
      `成功：${withoutFinalPunctuation(proposal.successCondition)}；失败：${withoutFinalPunctuation(proposal.failureCondition)}`,
    ),
    createFact('节奏与时长', `${paceLabel(proposal.pace)} · 约 ${proposal.sessionLengthMinutes} 分钟`),
  );

  const loop = document.createElement('ul');
  loop.className = 'proposal-option__loop';
  renderCoreLoop(loop, proposal.coreLoop);

  const visual = document.createElement('p');
  visual.className = 'proposal-option__visual';
  const visualTitle = document.createElement('strong');
  visualTitle.textContent = '画面感觉';
  visual.append(visualTitle, document.createTextNode(proposal.visualDirection));

  body.append(top, title, oneLiner, facts, loop, visual);
  label.append(input, body);
  return label;
}

function showProposals(planning) {
  hideCreationPanels();
  hidePreviewFlowPanels();
  elements.previewTitle.textContent = '比较三个玩法方向';
  elements.previewStage.hidden = true;
  elements.proposalBoard.hidden = false;
  elements.versionStrip.hidden = true;
  selectedProposalId = planning.selectedProposalId ?? selectedProposalId;
  elements.proposalList.replaceChildren();
  planning.proposals.forEach((proposal, index) => {
    elements.proposalList.append(createProposalOption(proposal, index));
  });
  const proposal = selectedProposal();
  elements.confirmProposalButton.disabled = !proposal;
  elements.proposalSelectionHelp.textContent = proposal
    ? `已选择“${proposal.name}”。`
    : '选择一个方向后继续。';
}

function createStyleOption(proposal, index) {
  const styleId = `style-${String.fromCharCode(97 + index)}`;
  const label = document.createElement('label');
  label.className = 'style-option';
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'style';
  input.value = styleId;
  input.checked = styleId === selectedStyleId;
  input.addEventListener('change', () => {
    selectedStyleId = styleId;
    elements.confirmStyleButton.disabled = false;
    elements.styleSelectionHelp.textContent = `已选择 ${String.fromCharCode(65 + index)}：${proposal.visualDirection}`;
  });
  const body = document.createElement('span');
  body.className = 'style-option__body';
  const title = document.createElement('strong');
  title.textContent = `${String.fromCharCode(65 + index)} · ${proposal.name}`;
  const copy = document.createElement('small');
  copy.textContent = proposal.visualDirection;
  body.append(title, copy);
  label.append(input, body);
  return label;
}

async function loadStyleBoardImage(imageUrl) {
  const response = await fetch(`${imageUrl}?v=${encodeURIComponent(currentPlanning.styleBoard.generatedAt ?? '')}`, {
    headers: { 'x-project-token': session.token },
  });
  if (!response.ok) throw new Error('参考图暂时无法打开，请重新生成。');
  const blob = await response.blob();
  if (styleBoardObjectUrl) URL.revokeObjectURL(styleBoardObjectUrl);
  styleBoardObjectUrl = URL.createObjectURL(blob);
  elements.styleBoardImage.style.backgroundImage = `url("${styleBoardObjectUrl}")`;
}

function showStyleBoard(planning) {
  hidePreviewFlowPanels();
  elements.previewStage.hidden = true;
  elements.versionStrip.hidden = true;
  elements.styleBoard.hidden = false;
  elements.previewTitle.textContent = '比较三个画面方向';
  const ready = planning.styleBoard?.status === 'ready';
  const failed = planning.styleBoard?.status === 'failed';
  const generating = planning.styleBoard?.status === 'generating';
  elements.styleBoardLoading.hidden = !generating;
  elements.styleBoardFigure.hidden = !ready;
  elements.styleOptions.hidden = !ready;
  elements.retryStyleButton.hidden = !failed && planning.styleBoard?.status !== 'not_started';
  elements.retryStyleButton.textContent = failed ? '重新生成参考图' : '生成参考图';
  elements.confirmStyleButton.hidden = !ready;
  if (!ready) {
    elements.styleSelectionHelp.textContent = failed
      ? planning.styleBoard.error?.message ?? '参考图生成失败，可以重新尝试。'
      : '正在生成一张三分区参考图，不会重复扣费。';
    return;
  }
  selectedStyleId = planning.selectedStyleId ?? selectedStyleId;
  elements.styleOptions.replaceChildren();
  planning.proposals.forEach((proposal, index) => {
    elements.styleOptions.append(createStyleOption(proposal, index));
  });
  elements.confirmStyleButton.disabled = !selectedStyleId;
  elements.styleSelectionHelp.textContent = selectedStyleId
    ? `已选择 ${selectedStyleId.slice(-1).toUpperCase()} 方向。`
    : '选择一个画面方向后继续。';
  loadStyleBoardImage(planning.styleBoard.imageUrl).catch((error) => showMessage(error.message));
}

function showContract(planning) {
  const contract = planning.gameContract;
  hidePreviewFlowPanels();
  elements.previewStage.hidden = true;
  elements.versionStrip.hidden = true;
  elements.contractBoard.hidden = false;
  elements.previewTitle.textContent = contract.status === 'confirmed' ? '玩法合同已确认' : '确认后再开始生成';
  elements.contractRole.textContent = contract.playerRole;
  elements.contractGoal.textContent = contract.goal;
  elements.contractControls.textContent = contract.controls;
  elements.contractDuration.textContent = `${contract.sessionLengthMinutes} 分钟 · ${paceLabel(contract.pace)}节奏`;
  elements.contractLoop.textContent = contract.coreLoop.join(' → ');
  elements.contractEnding.textContent = `成功：${withoutFinalPunctuation(contract.successCondition)}；失败：${withoutFinalPunctuation(contract.failureCondition)}`;
  elements.contractVisual.textContent = contract.visualDirection;
  elements.contractLocked.textContent = contract.lockedFields.join('、');
  elements.contractBudget.textContent = `最多 ${contract.imageBudget.maximum} 张；参考图已用 ${contract.imageBudget.used} 张，还可用 ${contract.imageBudget.remaining} 张`;
  elements.contractAcceptance.textContent = contract.acceptanceCriteria.join('；');
  elements.confirmContractButton.disabled = contract.status === 'confirmed';
  elements.confirmContractButton.textContent = contract.status === 'confirmed' ? '合同已确认' : '确认合同';
}

function renderPlanning(planning) {
  currentPlanning = planning;
  if (planning.selectedProposalId) selectedProposalId = planning.selectedProposalId;
  if (planning.selectedStyleId) selectedStyleId = planning.selectedStyleId;
  if (planning.selectedProposalId && selectedProposal()) {
    showPlan(currentProject, selectedProposal());
    if (planning.gameContract) showContract(planning);
    else showStyleBoard(planning);
  } else if (planning.proposals.length > 0) {
    showProposals(planning);
  } else if (planning.pendingQuestion) {
    showQuestion(planning);
  }
}

async function continuePlanning(answer) {
  clearMessage();
  hideCreationPanels();
  showPreviewPlaceholder('AI 正在拆解你的想法。', '它只会追问真正影响玩法的选择。');
  setPlanningBusy(true);
  try {
    const { planning } = await api(`/api/projects/${session.projectId}/planning`, {
      method: 'POST',
      body: JSON.stringify(answer ? { answer } : {}),
    });
    renderPlanning(planning);
  } catch (error) {
    elements.ideaForm.hidden = false;
    showMessage(`${error.message} 可以稍后重试，不会丢失已经保存的回答。`);
  } finally {
    setPlanningBusy(false);
  }
}

async function generateStyleBoardFlow() {
  clearMessage();
  elements.styleBoardLoading.hidden = false;
  elements.styleBoardFigure.hidden = true;
  elements.styleOptions.hidden = true;
  elements.retryStyleButton.hidden = true;
  elements.confirmStyleButton.hidden = true;
  elements.styleSelectionHelp.textContent = '正在生成一张三分区参考图，不会重复扣费。';
  showTask('running', 'style');
  elements.taskStateText.textContent = '正在生成参考图';
  try {
    const { planning } = await api(`/api/projects/${session.projectId}/planning/style-board`, {
      method: 'POST',
      body: '{}',
    });
    currentPlanning = planning;
    elements.taskState.hidden = true;
    renderPlanning(planning);
  } catch (error) {
    elements.taskState.hidden = true;
    const { planning } = await api(`/api/projects/${session.projectId}/planning`).catch(() => ({ planning: currentPlanning }));
    if (planning) renderPlanning(planning);
    showMessage(`${error.message} 可以重新生成参考图，已经确认的玩法不会丢失。`);
  }
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

function proposalInstruction(proposal) {
  return [
    `严格按照已经选择的玩法“${proposal.name}”生成第一版。`,
    `一句话体验：${proposal.oneLiner}`,
    `玩家身份：${proposal.playerRole}`,
    `目标：${proposal.goal}`,
    `核心循环：${proposal.coreLoop.join(' → ')}`,
    `操作：${proposal.controls}`,
    `成功条件：${proposal.successCondition}`,
    `失败条件：${proposal.failureCondition}`,
    `单局时长：${proposal.sessionLengthMinutes} 分钟。节奏：${paceLabel(proposal.pace)}。`,
    `视觉方向：${proposal.visualDirection}`,
    `高光时刻：${proposal.highlightMoment}`,
    `首版简化：${proposal.simplifications.join('；')}`,
    '不要擅自替换为另外两个提案的核心玩法。',
  ].join('\n');
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
  hideCreationPanels();
  hidePreviewFlowPanels();
  elements.previewStage.hidden = false;
  elements.previewTitle.textContent = '你的游戏已经可以试玩';
  elements.gameFrame.hidden = false;
  elements.gameFrame.srcdoc = await previewResponse.text();
  elements.emptyPreview.hidden = true;

  const { versions } = await api(`/api/projects/${session.projectId}/versions`);
  const current = versions.at(-1);
  if (current) {
    elements.versionNumber.textContent = `v${current.number}`;
    elements.generatorLabel.textContent =
      current.generatorMode === 'demo' ? '开发演示 · 非真实 AI 生成' : 'OpenGame 生成';
    elements.versionStrip.hidden = false;
  }
  elements.modifyPanel.hidden = false;
  const { project } = await api(`/api/projects/${session.projectId}`);
  currentProject = project;
  const pendingPlan = project.pendingChangePlan;
  if (pendingPlan?.status === 'awaiting_confirmation') {
    elements.instruction.value = pendingPlan.feedback;
    selectedFeedbackCategory = pendingPlan.presetCategory ?? 'custom';
    showChangePlan(pendingPlan);
  } else {
    showFeedbackComposer();
    if (pendingPlan?.status === 'failed') {
      showMessage(`${pendingPlan.error?.message ?? '上一次修改没有完成。'} 原来的可玩版本仍然保留。`);
    }
  }
}

async function restoreProject() {
  if (!session?.projectId || !session?.token) return;
  try {
    const { project } = await api(`/api/projects/${session.projectId}`);
    currentProject = project;
    elements.idea.value = project.idea;
    if (project.currentVersionId) {
      await loadPlayableVersion();
      return;
    }
    const { planning } = await api(`/api/projects/${session.projectId}/planning`);
    currentPlanning = planning;
    if (planning.status === 'not_started') await continuePlanning();
    else renderPlanning(planning);
  } catch (error) {
    localStorage.removeItem(storageKey);
    session = null;
    currentProject = null;
    currentPlanning = null;
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
    const idea = elements.idea.value.trim();
    if (!currentProject || currentProject.idea !== idea || currentProject.currentVersionId) {
      const created = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ idea }),
      });
      currentProject = created.project;
      currentPlanning = created.project.planning;
      selectedProposalId = null;
      selectedStyleId = null;
      saveSession({ projectId: created.project.id, token: created.token });
    }
    await continuePlanning();
    setButtonState(elements.createButton, 'success');
  } catch (error) {
    setButtonState(elements.createButton, 'error');
    showMessage(`${error.message} 检查后端连接后再试。`);
  }
});

elements.answerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const answer = elements.customAnswer.value.trim();
  if (!answer) {
    elements.customAnswer.setAttribute('aria-invalid', 'true');
    showMessage('请写下回答，或者直接选择上面的一个选项。');
    elements.customAnswer.focus();
    return;
  }
  elements.customAnswer.setAttribute('aria-invalid', 'false');
  await continuePlanning(answer);
});

elements.confirmProposalButton.addEventListener('click', async () => {
  const proposal = selectedProposal();
  if (!proposal) return;
  clearMessage();
  setButtonState(elements.confirmProposalButton, 'loading');
  try {
    const selected = await api(`/api/projects/${session.projectId}/planning/selection`, {
      method: 'POST',
      body: JSON.stringify({ proposalId: proposal.id }),
    });
    currentPlanning = selected.planning;
    selectedProposalId = selected.proposal.id;
    selectedStyleId = null;
    renderPlanning(selected.planning);
    await generateStyleBoardFlow();
  } catch (error) {
    showMessage(error.message);
  } finally {
    setButtonState(elements.confirmProposalButton, 'idle');
  }
});

elements.reselectProposalButton.addEventListener('click', () => {
  if (currentPlanning?.proposals?.length) showProposals(currentPlanning);
});

elements.retryStyleButton.addEventListener('click', generateStyleBoardFlow);

elements.confirmStyleButton.addEventListener('click', async () => {
  if (!selectedStyleId) return;
  clearMessage();
  setButtonState(elements.confirmStyleButton, 'loading');
  try {
    const { planning } = await api(`/api/projects/${session.projectId}/planning/style-selection`, {
      method: 'POST',
      body: JSON.stringify({ styleId: selectedStyleId }),
    });
    renderPlanning(planning);
  } catch (error) {
    showMessage(error.message);
  } finally {
    setButtonState(elements.confirmStyleButton, 'idle');
  }
});

elements.changeStyleButton.addEventListener('click', () => {
  if (currentPlanning?.styleBoard?.status === 'ready') showStyleBoard(currentPlanning);
});

elements.confirmContractButton.addEventListener('click', async () => {
  clearMessage();
  setButtonState(elements.confirmContractButton, 'loading');
  try {
    const { planning } = await api(`/api/projects/${session.projectId}/planning/contract/confirm`, {
      method: 'POST',
      body: '{}',
    });
    renderPlanning(planning);
  } catch (error) {
    showMessage(error.message);
  } finally {
    setButtonState(elements.confirmContractButton, 'idle');
    elements.confirmContractButton.disabled = currentPlanning?.gameContract?.status === 'confirmed';
  }
});

elements.editIdeaButton.addEventListener('click', () => {
  hideCreationPanels();
  elements.ideaForm.hidden = false;
  showPreviewPlaceholder('写下新的想法。', '提交后会建立一个新的创作项目。');
  elements.idea.focus();
});

elements.generateButton.addEventListener('click', () => {
  if (currentPlanning?.gameContract?.status !== 'confirmed') {
    showMessage('请先确认玩法合同。');
    return;
  }
  createGeneration('按已确认的玩法合同生成第一版。', elements.generateButton);
});

elements.feedbackPresets.querySelectorAll('button').forEach((button) => {
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => {
    selectedFeedbackCategory = button.dataset.category;
    elements.instruction.value = button.dataset.feedback;
    elements.feedbackPresets.querySelectorAll('button').forEach((option) => {
      option.setAttribute('aria-pressed', String(option === button));
    });
    elements.instruction.focus();
  });
});

elements.modifyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const instruction = elements.instruction.value.trim();
  if (instruction.length < 2 || instruction.length > 1000) {
    elements.instruction.setAttribute('aria-invalid', 'true');
    showMessage('试玩反馈需要 2 到 1000 个字符。请说明哪里不符合预期。');
    elements.instruction.focus();
    return;
  }
  elements.instruction.setAttribute('aria-invalid', 'false');
  clearMessage();
  setButtonState(elements.modifyButton, 'loading');
  try {
    const { plan } = await api(`/api/projects/${session.projectId}/feedback/preview`, {
      method: 'POST',
      body: JSON.stringify({ feedback: instruction, category: selectedFeedbackCategory }),
    });
    showChangePlan(plan);
  } catch (error) {
    showMessage(`${error.message} 已有游戏不会受到影响，可以稍后重试。`);
  } finally {
    setButtonState(elements.modifyButton, 'idle');
  }
});

elements.editFeedbackButton.addEventListener('click', () => {
  showFeedbackComposer();
  elements.instruction.focus();
});

elements.confirmChangeButton.addEventListener('click', async () => {
  if (!currentChangePlan) return;
  clearMessage();
  setButtonState(elements.confirmChangeButton, 'loading');
  showTask('queued', 'queued');
  try {
    const { task } = await api(`/api/projects/${session.projectId}/feedback/confirm`, {
      method: 'POST',
      body: JSON.stringify({ planId: currentChangePlan.id }),
    });
    await pollTask(task.id);
    elements.instruction.value = '';
    selectedFeedbackCategory = 'custom';
    elements.feedbackPresets.querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-pressed', 'false');
    });
  } catch (error) {
    setButtonState(elements.confirmChangeButton, 'error');
    showMessage(`${error.message} 原来的可玩版本仍然保留。`);
    showTask('failed', 'failed');
  }
});

await checkService();
await restoreProject();
