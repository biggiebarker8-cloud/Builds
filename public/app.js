const $ = (selector) => document.querySelector(selector);
let state;
let notificationTimer;
const pages = ['overview', 'creators', 'tasks', 'connections', 'finance', 'security', 'settings'];
const ownerPages = ['finance', 'settings'];
const isOwner = () => state?.role === 'owner';

function notify(message) {
  $('#notification').textContent = message;
  $('#notification').hidden = false;
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => { $('#notification').hidden = true; }, 7000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (response.status === 401) {
    showLogin();
    throw new Error('Please sign in with your password or workspace access token.');
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'The request could not be completed.');
  }
  return response.status === 204 ? null : response.json();
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function action(text, handler, className = 'secondary') {
  const button = node('button', text, className);
  button.type = 'button';
  button.addEventListener('click', () => run(button, handler));
  return button;
}

async function run(button, handler) {
  button.disabled = true;
  try { await handler(); } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
}

function showLogin() {
  $('#login').hidden = false;
  $('#workspace').hidden = true;
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  state = undefined;
  $('#finance-rows').replaceChildren();
  $('#finance-form').reset();
  $('#password-form').reset();
  $('#lark-message-form').reset();
  $('#password-status').textContent = '';
  $('#role-badge').textContent = '';
  document.querySelectorAll('[data-owner-only]').forEach((element) => { element.hidden = true; });
}

function route() {
  let page = pages.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  if (ownerPages.includes(page) && !isOwner()) page = 'overview';
  document.querySelectorAll('.page').forEach((section) => { section.hidden = section.id !== page; });
  document.querySelectorAll('nav a').forEach((link) => {
    const active = link.hash === `#${page}`;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#page-label').textContent = {
    overview: 'Overview', creators: 'Creator roster', tasks: 'Operations',
    connections: 'Connections', finance: 'Payments & charges', security: 'Security', settings: 'Agency settings',
  }[page];
}

function currency(value, market) {
  return new Intl.NumberFormat(market === 'AU' ? 'en-AU' : 'en-GB', {
    style: 'currency', currency: market === 'AU' ? 'AUD' : 'GBP', maximumFractionDigits: 2,
  }).format(value);
}

function marketLabel(market) {
  return market === 'AU' ? 'Australia' : 'UK · planning';
}

function renderSummary() {
  const market = $('#summary-market').value;
  const creators = state.creators.filter((creator) => creator.market === market);
  $('#metric-creators').textContent = creators.filter((creator) => creator.status === 'active').length;
  $('#metric-hours').textContent = creators.reduce((sum, creator) => sum + creator.liveHours, 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  $('#metric-revenue').textContent = currency(creators.reduce((sum, creator) => sum + creator.revenue, 0), market);
  $('#metric-tasks').textContent = state.tasks.filter((task) => !task.done && task.market === market).length;
  const upcoming = state.tasks.filter((task) => !task.done && task.market === market)
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')).slice(0, 4);
  $('#upcoming').replaceChildren(...upcoming.map((task) => taskRow(task, true)));
  if (!upcoming.length) $('#upcoming').append(node('p', 'A clear runway. Add a task to plan your next move.', 'empty'));
}

function renderCreators() {
  const search = $('#creator-search').value.trim().toLowerCase();
  const market = $('#creator-market').value;
  const creators = state.creators.filter((creator) =>
    (!market || creator.market === market) && `${creator.handle} ${creator.manager}`.toLowerCase().includes(search));
  $('#creator-rows').replaceChildren(...creators.map((creator) => {
    const row = node('tr');
    [creator.handle, marketLabel(creator.market), creator.manager || 'Unassigned'].forEach((value) => row.append(node('td', value)));
    const status = node('td');
    status.append(node('span', creator.status, `badge${creator.status === 'active' ? '' : ' neutral'}`));
    row.append(status, node('td', `${creator.liveHours} / ${creator.targetHours}`), node('td', currency(creator.revenue, creator.market)));
    const actions = node('td');
    const group = node('div', undefined, 'row-actions');
    group.append(action('Edit', () => openCreator(creator)), action('Delete', async () => {
      if (!confirm(`Delete ${creator.handle}? This cannot be undone.`)) return;
      await api(`/api/creators/${creator.id}`, { method: 'DELETE' });
      await refresh();
      notify('Creator deleted.');
    }));
    actions.append(group);
    row.append(actions);
    return row;
  }));
  $('#creator-empty').hidden = creators.length > 0;
  $('#creator-empty').textContent = state.creators.length
    ? 'No creators match your filters.' : 'Your roster starts here. Add your first creator to get moving.';
}

function taskRow(task, compact = false) {
  const row = node('div', undefined, `task-row${task.done ? ' done' : ''}`);
  const toggle = node('input');
  toggle.type = 'checkbox';
  toggle.checked = task.done;
  toggle.setAttribute('aria-label', `Mark ${task.title} ${task.done ? 'incomplete' : 'complete'}`);
  toggle.addEventListener('change', () => run(toggle, async () => {
    try {
      await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ done: toggle.checked }) });
      await refresh();
    } catch (error) {
      toggle.checked = task.done;
      throw error;
    }
  }));
  const detail = node('div', undefined, 'task-details');
  detail.append(node('strong', task.title), node('small', `${marketLabel(task.market)} · ${task.dueDate || 'No due date'}`));
  row.append(toggle, detail);
  if (!compact) row.append(action('Delete', async () => {
    if (!confirm('Delete this task?')) return;
    await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
    await refresh();
  }, 'quiet'));
  return row;
}

function render() {
  $('#anycross-endpoint').value = new URL('/api/automation/lark/messages', window.location.origin).href;
  document.querySelectorAll('[data-owner-only]').forEach((element) => { element.hidden = !isOwner(); });
  $('#role-badge').textContent = isOwner() ? 'OWNER' : 'MANAGER';
  if (!isOwner()) {
    $('#finance-dialog').close();
    $('#finance-form').reset();
  }
  $('#settings-form').querySelectorAll('input, select, button').forEach((element) => { element.disabled = !isOwner(); });
  const settings = state.settings;
  const form = $('#settings-form');
  ['agencyName', 'accountHandle', 'auTimezone'].forEach((key) => { form.elements[key].value = settings[key]; });
  form.elements.ukEnabled.checked = settings.ukEnabled;
  $('#agency-footer').textContent = `${settings.agencyName} · @${settings.accountHandle.replace(/^@/, '')}`;
  document.querySelectorAll('select[name="market"] option[value="UK"], #summary-market option[value="UK"]').forEach((option) => {
    option.disabled = !settings.ukEnabled;
  });
  if (!settings.ukEnabled) $('#summary-market').value = 'AU';
  const configured = state.integrations.lark.status === 'configured';
  $('#lark-status').textContent = configured ? 'Configured · not verified' : 'Not configured';
  $('#lark-overview').textContent = configured ? 'Configured · not verified' : 'Not configured';
  $('#lark-test').disabled = !configured;
  $('#lark-send').disabled = !configured;
  renderSummary();
  renderCreators();
  renderFinance();
  $('#task-list').replaceChildren(...state.tasks.map((task) => taskRow(task)));
  if (!state.tasks.length) $('#task-list').append(node('p', 'No tasks yet. Start with an onboarding or creator-support priority.', 'empty'));
  updateClock();
  route();
}

function renderFinance() {
  $('#finance-rows').replaceChildren();
  if (!isOwner()) return;
  const records = state.finance || [];
  $('#finance-empty').hidden = records.length > 0;
  $('#finance-rows').replaceChildren(...records.map((record) => {
    const row = node('tr');
    [record.date, record.description, record.type === 'payment' ? 'Payment' : 'Administrative charge',
      marketLabel(record.market), currency(record.amount, record.market),
      record.status === 'recorded' ? 'Recorded manually' : record.status].forEach((value) => row.append(node('td', value)));
    const cell = node('td');
    const actions = node('div', undefined, 'row-actions');
    actions.append(action('Edit', () => openFinance(record)), action('Delete', async () => {
      if (!confirm('Permanently delete this financial record? This cannot be undone.')) return;
      await api(`/api/finance/${record.id}`, { method: 'DELETE' });
      await refresh();
      notify('Financial record deleted.');
    }));
    cell.append(actions);
    row.append(cell);
    return row;
  }));
}

function openFinance(record) {
  if (!isOwner()) return;
  const form = $('#finance-form');
  form.reset();
  form.elements.id.value = '';
  $('#finance-dialog-title').textContent = record ? 'Edit financial record' : 'Add financial record';
  if (record) Object.keys(record).forEach((key) => {
    if (form.elements[key]) form.elements[key].value = record[key];
  });
  $('#finance-dialog').showModal();
}

function updateClock() {
  if (!state) return;
  $('#local-time').textContent = new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: state.settings.auTimezone,
  }).format(new Date()) + ` · ${state.settings.auTimezone}`;
}

async function refresh() {
  state = await api('/api/state');
  const security = await api('/api/security');
  $('#password-status').textContent = `${security.role === 'owner' ? 'Owner' : 'Manager'} access · ${security.hasPassword ? 'Password set. You can change it below.' : 'No password set yet. Use your setup token below to create one.'}`;
  render();
}

function openCreator(creator) {
  const form = $('#creator-form');
  form.reset();
  form.elements.id.value = '';
  $('#creator-dialog-title').textContent = creator ? 'Edit creator' : 'Add creator';
  if (creator) Object.keys(creator).forEach((key) => {
    if (form.elements[key]) form.elements[key].value = creator[key];
  });
  $('#creator-dialog').showModal();
}

$('#login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    const form = event.target;
    const credentials = $('#login-method').value === 'password'
      ? { role: form.elements.role.value, password: form.elements.credential.value }
      : { token: form.elements.credential.value };
    await api('/api/login', { method: 'POST', body: JSON.stringify(credentials) });
    event.target.reset();
    await refresh();
    $('#login').hidden = true;
    $('#workspace').hidden = false;
    route();
  });
});

$('#login-method').addEventListener('change', () => {
  const password = $('#login-method').value === 'password';
  $('#login-role-label').hidden = !password;
  $('#login-credential-label').textContent = password ? 'Password' : 'Workspace access token';
  const input = $('#login-form').elements.credential;
  input.value = '';
  input.maxLength = password ? 128 : 4096;
});

$('#password-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.elements.password.value !== form.elements.confirmation.value) {
    notify('The new passwords do not match.');
    form.elements.confirmation.focus();
    return;
  }
  run(event.submitter, async () => {
    const result = await api('/api/security/password', {
      method: 'PUT',
      body: JSON.stringify({
        currentCredential: form.elements.currentCredential.value,
        password: form.elements.password.value,
      }),
    });
    form.reset();
    await refresh();
    notify(result.message);
  });
});

$('#logout').addEventListener('click', (event) => run(event.currentTarget, async () => {
  await api('/api/logout', { method: 'POST' });
  showLogin();
}));

$('#overview-add').addEventListener('click', () => openCreator());
$('#add-creator').addEventListener('click', () => openCreator());
$('#add-task').addEventListener('click', () => {
  $('#task-form').reset();
  $('#task-dialog').showModal();
});
document.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));

$('#creator-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    const data = Object.fromEntries(new FormData(event.target));
    const id = data.id;
    delete data.id;
    ['liveHours', 'targetHours', 'revenue'].forEach((key) => { data[key] = Number(data[key]); });
    await api(id ? `/api/creators/${id}` : '/api/creators', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(data) });
    $('#creator-dialog').close();
    await refresh();
    notify(id ? 'Creator updated.' : 'Creator added.');
  });
});

$('#task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    $('#task-dialog').close();
    await refresh();
    notify('Task created.');
  });
});

$('#settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!isOwner()) return;
  run(event.submitter, async () => {
    const data = Object.fromEntries(new FormData(event.target));
    data.ukEnabled = event.target.elements.ukEnabled.checked;
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify(data) });
    await refresh();
    notify('Agency settings saved.');
  });
});

$('#add-finance').addEventListener('click', () => openFinance());
$('#finance-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!isOwner()) return;
  run(event.submitter, async () => {
    const data = Object.fromEntries(new FormData(event.target));
    const id = data.id;
    delete data.id;
    data.amount = Number(data.amount);
    await api(id ? `/api/finance/${id}` : '/api/finance', {
      method: id ? 'PATCH' : 'POST', body: JSON.stringify(data),
    });
    $('#finance-dialog').close();
    await refresh();
    notify('Financial record saved. No funds were moved.');
  });
});

$('#export').addEventListener('click', (event) => run(event.currentTarget, async () => {
  const response = await fetch('/api/export');
  if (response.status === 401) {
    showLogin();
    throw new Error('Please sign in again.');
  }
  if (!response.ok) throw new Error('Export failed. Please try again.');
  const url = URL.createObjectURL(await response.blob());
  const link = node('a');
  link.href = url;
  link.download = 'alliance-creators.csv';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}));

$('#lark-test').addEventListener('click', (event) => run(event.currentTarget, async () => {
  const result = await api('/api/integrations/lark/test', { method: 'POST' });
  notify(result.message);
}));

$('#lark-message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (!form.elements.message.value.trim()) {
    notify('Enter a message before sending.');
    return;
  }
  if (!confirm('Send this message now to your configured Lark chat?')) return;
  run(event.submitter, async () => {
    const result = await api('/api/integrations/lark/messages', {
      method: 'POST', body: JSON.stringify({ message: form.elements.message.value }),
    });
    form.reset();
    notify(result.message);
  });
});

$('#creator-search').addEventListener('input', () => state && renderCreators());
$('#creator-market').addEventListener('change', () => state && renderCreators());
$('#summary-market').addEventListener('change', () => state && renderSummary());
window.addEventListener('hashchange', route);
setInterval(updateClock, 60000);

(async () => {
  try {
    await api('/api/session');
    await refresh();
    $('#login').hidden = true;
    $('#workspace').hidden = false;
    route();
  } catch (error) {
    showLogin();
    if (!error.message.includes('sign in')) notify('Cannot reach the server. Check that the application is running.');
  }
})();
