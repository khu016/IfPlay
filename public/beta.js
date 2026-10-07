const elements = {
  login: document.querySelector('#admin-login'),
  form: document.querySelector('#admin-form'),
  token: document.querySelector('#admin-token'),
  message: document.querySelector('#admin-message'),
  dashboard: document.querySelector('#beta-dashboard'),
  refresh: document.querySelector('#refresh-button'),
  invites: document.querySelector('#metric-invites'),
  invitesDetail: document.querySelector('#metric-invites-detail'),
  testers: document.querySelector('#metric-testers'),
  projects: document.querySelector('#metric-projects'),
  playtests: document.querySelector('#metric-playtests'),
  completion: document.querySelector('#metric-completion'),
  inviteForm: document.querySelector('#invite-create-form'),
  codes: document.querySelector('#new-invite-codes'),
  inviteMessage: document.querySelector('#invite-create-message'),
  reviewList: document.querySelector('#review-list'),
  playtestList: document.querySelector('#playtest-list'),
};

let adminToken = sessionStorage.getItem('ifplay.beta.admin') ?? '';

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('x-admin-token', adminToken);
  if (options.body) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...options, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? '请求失败。');
  return body;
}

function card(title, body, meta = '') {
  const article = document.createElement('article');
  article.className = 'review-card';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = body;
  article.append(heading, copy);
  if (meta) {
    const small = document.createElement('small');
    small.textContent = meta;
    article.append(small);
  }
  return article;
}

function renderSummary(beta) {
  elements.invites.textContent = String(beta.invites.total);
  elements.invitesDetail.textContent = `${beta.invites.active} 个未使用 · ${beta.invites.redeemed} 个已兑换`;
  elements.testers.textContent = String(beta.testers.length);
  elements.projects.textContent = String(beta.projects);
  elements.playtests.textContent = String(beta.playtests.length);
  const completed = beta.playtests.filter((item) => item.outcome === 'completed').length;
  elements.completion.textContent = beta.playtests.length
    ? `${completed}/${beta.playtests.length} 完成一轮`
    : '等待第一条真实记录';

  elements.reviewList.replaceChildren();
  const pending = beta.moderation.filter((item) => item.status === 'pending');
  if (pending.length === 0) elements.reviewList.append(card('目前没有待复核内容', '规则允许的内容会直接通过，高风险内容会直接拦截。'));
  pending.forEach((item) => {
    const entry = card(item.kind, item.text, item.reasons.join(' · '));
    const actions = document.createElement('div');
    actions.className = 'review-card__actions';
    [['approved', '允许原样重试'], ['rejected', '拒绝']].forEach(([decision, label]) => {
      const button = document.createElement('button');
      button.className = decision === 'approved' ? 'action action--secondary' : 'text-action';
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', async () => {
        await api(`/api/admin/moderation/${item.id}`, {
          method: 'POST',
          body: JSON.stringify({ decision }),
        });
        await loadDashboard();
      });
      actions.append(button);
    });
    entry.append(actions);
    elements.reviewList.append(entry);
  });

  elements.playtestList.replaceChildren();
  if (beta.playtests.length === 0) elements.playtestList.append(card('还没有试玩记录', '测试者生成并试玩后，可以在创作页提交结果。'));
  [...beta.playtests].reverse().forEach((item) => {
    const outcome = { completed: '完成一轮', blocked: '遇到阻断', abandoned: '中途退出' }[item.outcome];
    elements.playtestList.append(card(`${outcome} · ${item.rating}/5`, item.notes, new Date(item.createdAt).toLocaleString('zh-CN')));
  });
}

async function loadDashboard() {
  const { beta } = await api('/api/admin/beta');
  renderSummary(beta);
  elements.login.hidden = true;
  elements.dashboard.hidden = false;
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  adminToken = elements.token.value.trim();
  elements.message.hidden = true;
  try {
    await loadDashboard();
    sessionStorage.setItem('ifplay.beta.admin', adminToken);
  } catch (error) {
    elements.message.textContent = error.message;
    elements.message.hidden = false;
  }
});

elements.refresh.addEventListener('click', loadDashboard);

elements.inviteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = new FormData(elements.inviteForm);
  elements.inviteMessage.hidden = true;
  try {
    const result = await api('/api/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ count: Number(values.get('count')), maxProjects: Number(values.get('maxProjects')) }),
    });
    elements.codes.value = result.codes.join('\n');
    elements.codes.hidden = false;
    await loadDashboard();
  } catch (error) {
    elements.inviteMessage.textContent = error.message;
    elements.inviteMessage.hidden = false;
  }
});

if (adminToken) loadDashboard().catch(() => sessionStorage.removeItem('ifplay.beta.admin'));
