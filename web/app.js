const state = { role: 'ALL', status: 'ALL', search: '' };
const page = document.body.dataset.page || 'snapshot';
const $ = (selector) => document.querySelector(selector);
const PROFILE_ACCOUNTS_KEY = 'champion-fit-profile-accounts';
const PROFILE_GROUPS_KEY = 'champion-fit-profile-groups';
const COMPANION_FILTER_KEY = 'champion-fit-companion-filter';
let friendsLoadSequence = 0;
let friendsFiltersInitialized = false;

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}
function pct(value, digits = 1) { return `${Number(value).toFixed(digits)}%`; }
function fixed(value, digits = 1) { return Number(value).toFixed(digits); }
function interval90(lower, upper) {
  const low = Number(lower); const high = Number(upper);
  return Number.isFinite(low) && Number.isFinite(high) ? `${pct(low * 100, 0)}–${pct(high * 100, 0)}` : 'non aggregabile tra ruoli';
}
function initials(name) { return String(name).replace(/[^A-Z]/g, '').slice(0, 2) || String(name).slice(0, 2).toUpperCase(); }
function avatar(item) {
  return `<span class="avatar"><img src="${esc(item.icon_url)}" alt="${esc(item.champion)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.hidden=false"><b hidden>${esc(initials(item.champion))}</b></span>`;
}
function statusPill(item) {
  if (item.record_kind === 'screen') return '<span class="pill screen">Screening teorico</span>';
  if (item.blacklist_strong || item.tier === 'strong') return '<span class="pill strong">Blacklist forte</span>';
  if (item.blacklist_provisional || item.tier === 'provisional') return '<span class="pill provisional">Provvisoria</span>';
  if (Number(item.allocated_games) > 0) return '<span class="pill testing">Da testare</span>';
  if (item.validated_positive) return '<span class="pill">Validato</span>';
  return '<span class="pill">Osservazione</span>';
}
function humanizeFlags(flags) {
  const labels = { none:'Nessuna anomalia rilevata', very_short:'Partita molto breve', short_10_15:'Partita breve: 10-15 min', caution_20_23:'Partita breve: 20-23 min', early_surrender:'Resa anticipata', surrender:'Resa', explicit_afk_teammate:'AFK esplicito in squadra', suspected_quasi_afk_teammate:'Possibile quasi-AFK in squadra', early_team_collapse:'Squadra collassata presto', severe_kill_deficit:'Forte svantaggio di kill' };
  return String(flags || 'none').split(';').map((flag) => labels[flag.toLowerCase()] || flag.replaceAll('_', ' ')).join(' · ');
}
function humanizeReason(reason) {
  const text = String(reason || '');
  if (text.includes('almost non-informative')) return 'Questa loss non viene quasi usata: partita troppo breve, remake o condizioni simili ad AFK.';
  if (text.includes('partially attributed')) return 'Questa loss pesa solo in parte: durata o stato della squadra rendono incerta la responsabilità del champion.';
  if (text.includes('duration model v2')) return 'Peso calcolato con il modello storico per fasce di durata; i segnali esterni lo riducono ulteriormente.';
  if (text.includes('Victory evidence kept high')) return 'Vittoria considerata evidenza positiva affidabile.';
  return text;
}
async function api(path) {
  let response;
  try {
    response = await fetch(path);
  } catch (error) {
    throw new Error('Impossibile raggiungere il server. Avvia app.py e apri il sito da http://127.0.0.1:8787 (non dal file HTML).');
  }
  if (!response.ok) throw new Error(await apiError(response));
  return response.json();
}
async function apiError(response) {
  try {
    const body = await response.json();
    if (body?.message) return body.message;
    if (body?.error) return body.error;
  } catch (_) { /* The server may return an HTML error page. */ }
  return `API ${response.status}`;
}
async function apiPost(path, payload) {
  const response = await fetch(path, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(await apiError(response));
  return response.json();
}
async function apiPatch(path, payload) {
  const response = await fetch(path, { method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(await apiError(response));
  return response.json();
}
async function apiDelete(path) {
  const response = await fetch(path, { method: 'DELETE' });
  if (!response.ok) throw new Error(`API ${response.status}`);
  return response.json();
}
function accountQuery() {
  const accounts = readStoredJson(PROFILE_ACCOUNTS_KEY, []);
  if (!Array.isArray(accounts)) return '';
  return accounts.map((account) => `account=${encodeURIComponent(account)}`).join('&');
}
function companionQuery() {
  try {
    const filter = JSON.parse(localStorage.getItem(COMPANION_FILTER_KEY) || 'null');
    if (!filter || !Array.isArray(filter.accounts) || !filter.accounts.length || !['exclude', 'only'].includes(filter.mode)) return '';
    return `${filter.accounts.map((account) => `companion_account=${encodeURIComponent(account)}`).join('&')}&companion_mode=${encodeURIComponent(filter.mode)}`;
  } catch { return ''; }
}
function scopedQuery() { return [accountQuery(), companionQuery()].filter(Boolean).join('&'); }
async function loadGlobalAccountPicker() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar || document.querySelector('[data-global-account-picker]')) return;
  const data = await api('/api/accounts');
  const accounts = data.items || [];
  if (!accounts.length) return;
  let selected;
  try { selected = JSON.parse(localStorage.getItem(PROFILE_ACCOUNTS_KEY) || 'null'); } catch { selected = null; }
  selected = Array.isArray(selected) ? selected.filter((account) => accounts.some((item) => item.account === account)) : accounts.map((item) => item.account);
  if (!selected.length) selected = accounts.map((item) => item.account);
  localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(selected));
  const box = document.createElement('section');
  box.className = 'global-account-picker';
  box.dataset.globalAccountPicker = '1';
  box.innerHTML = `<p>ACCOUNT ATTIVO</p><details><summary>${selected.length === accounts.length ? 'Tutti gli account' : `${selected.length} account selezionati`}</summary><div class="global-account-options">${accounts.map((item) => `<label><input type="checkbox" value="${esc(item.account)}" ${selected.includes(item.account) ? 'checked' : ''}><span>${esc(item.account)}</span></label>`).join('')}<button type="button" data-apply-global-accounts>Applica selezione</button></div></details>`;
  sidebar.insertBefore(box, sidebar.querySelector('.sidebar-foot'));
  box.querySelector('[data-apply-global-accounts]').addEventListener('click', () => {
    const values = [...box.querySelectorAll('input:checked')].map((input) => input.value);
    if (!values.length) return;
    localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(values));
    window.location.reload();
  });
}
function savedProfileGroups() {
  try { const groups = JSON.parse(localStorage.getItem(PROFILE_GROUPS_KEY) || '{}'); return groups && typeof groups === 'object' ? groups : {}; }
  catch { return {}; }
}
function saveProfileGroups(groups) { localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify(groups)); }
function readStoredJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value === null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}
function setActiveNav() {
  const items = [
    ['snapshot', '/', 'Database snapshot'],
    ['profile', '/profile.html', 'Profilo competitivo'],
    ['friends', '/friends.html', 'Friends'],
    ['fit', '/fit.html', 'Fit matrix'],
    ['allocation', '/allocation.html', 'Exact allocation'],
    ['blacklist', '/blacklist.html', 'Blacklist'],
    ['audit', '/audit.html', 'Match audit'],
    ['scout', '/scout.html', 'Scout list'],
  ];
  document.querySelectorAll('nav[aria-label="Navigazione principale"]').forEach((nav) => {
    nav.innerHTML = items.map(([key, href, label], index) => `<a data-nav="${key}" href="${href}">${String(index + 1).padStart(2, '0')} <span>${label}</span></a>`).join('');
  });
  document.querySelectorAll('[data-nav]').forEach((link) => link.classList.toggle('active', link.dataset.nav === page));
}
function renderStamp(data) {
  const stamp = $('#data-stamp'); if (stamp && data.metadata) stamp.textContent = `aggiornato ${new Date(data.metadata.generated_at_utc).toLocaleString('it-IT')}`;
  const scope = $('#scope-label'); if (scope && data.metadata) scope.textContent = data.metadata.scope;
}
function renderSyncStatus(data) {
  let box = document.querySelector('[data-sync-status]');
  if (!box) {
    box = document.createElement('aside');
    box.className = 'sync-status';
    box.dataset.syncStatus = '1';
    document.body.appendChild(box);
  }
  const importing = data?.mode === 'importing';
  const count = Number(data?.checkpoint_accounts || 0);
  box.classList.toggle('is-live', importing);
  box.innerHTML = `<span class="sync-status-dot"></span><div><b>${importing ? 'IMPORT RIOT IN CORSO' : 'DATABASE PRONTO'}</b><small>${importing ? `${count} account con checkpoint · nessuna chiamata ripetuta` : 'snapshot locale · aggiornamento manuale'}</small></div>`;
}
async function loadSyncStatus() {
  try { renderSyncStatus(await api('/api/sync-status')); }
  catch (_) { /* The dashboard remains usable if the status endpoint is unavailable. */ }
}

function renderOverview(data) {
  renderStamp(data);
  const s = data.summary;
  const metricGrid = $('#metric-grid');
  if (metricGrid) metricGrid.innerHTML = [[s.observed_games, 'game standard analizzati'], [s.champion_role_pairs, 'coppie champion + ruolo'], [s.planned_games, 'game nel piano'], [s.contaminated_losses, 'loss poco attribuibili'], [`${s.strong_blacklist} + ${s.provisional_blacklist}`, 'blacklist forte + provvisoria']].map(([value, label]) => `<article class="metric"><b>${esc(value)}</b><span>${esc(label)}</span></article>`).join('');
  const roleBars = $('#role-bars');
  if (roleBars) { const maxGames = Math.max(...data.roles.map((role) => role.observed_games), 1); roleBars.innerHTML = data.roles.map((role) => `<article class="role-bar"><header><span>${esc(role.role)}</span><span>${role.observed_games}g / ${role.planned_games} test</span></header><div class="role-rail"><i style="width:${role.observed_games / maxGames * 100}%"></i></div></article>`).join(''); }
}

async function loadFit() {
  const rows = $('#fit-rows'); if (!rows) return;
  const accountPart = scopedQuery(); const filterQuery = new URLSearchParams(state).toString(); const data = await api(`/api/champions?${filterQuery}${accountPart ? `&${accountPart}` : ''}`);
  rows.innerHTML = data.items.length ? data.items.map((item) => `<tr><td><div class="champion-cell">${avatar(item)}<a class="champion-link" href="/champion.html?champion=${encodeURIComponent(item.champion)}&role=${encodeURIComponent(item.role)}">${esc(item.champion)}</a></div></td><td>${esc(item.role)}</td><td class="fit-number">${item.record_kind === 'screen' ? `Prior ${pct(Number(item.theoretical_fit_prior) * 100, 0)}` : pct(item.account_adjusted_fit_score)}</td><td>${item.record_kind === 'screen' ? 'Non giocato' : `${item.games_observed} <span class="confidence">${item.wins}-${item.losses}</span>`}</td><td>${item.record_kind === 'screen' ? '—' : fixed(item.informative_losses_equivalent, 2)}</td><td>${item.record_kind === 'screen' ? '—' : fixed(item.effective_sample_size, 1)}</td><td>${item.record_kind === 'screen' ? 'Da verificare' : pct(Number(item.uncertainty_width_90) * 100)}</td><td>${statusPill(item)}</td></tr>`).join('') : '<tr><td class="empty" colspan="8">Nessun champion corrisponde ai filtri.</td></tr>';
}

async function loadPlan(n = '') {
  const grid = $('#plan-grid'); if (!grid) return;
  const accountPart = scopedQuery(); const params = new URLSearchParams(accountPart); if (n) params.set('n', n);
  const role = $('#plan-role')?.value || 'ALL'; if (role !== 'ALL') params.set('role', role);
  const data = await api(`/api/plan?${params.toString()}`);
  const total = data.items.reduce((sum, item) => sum + Number(item.allocated_games), 0);
  const totalLabel = $('#plan-total'); if (totalLabel) totalLabel.textContent = `${total} GAME TOTALI`;
  const description = $('#plan-description'); if (description) description.textContent = `${data.role ? `Solo ruolo ${data.role} · ` : ''}Distribuzione esatta su ${total} game, scalata dal piano base da ${data.source_total} game.`;
  const items = data.items.filter((item) => Number(item.allocated_games) > 0);
  grid.innerHTML = items.length ? items.map((item) => `<article class="plan-card" title="${esc(item.quantitative_rationale)}"><header><div class="champion-cell">${avatar(item)}<div><h3>${esc(item.champion)}</h3><span class="pill testing">${esc(item.role)}</span></div></div><strong>${item.allocated_games}</strong></header><p>VOI ${fixed(item.base_value_of_information, 3)} · n eff. ${fixed(item.starting_effective_sample_size, 1)}<br>${pct(Number(item.probability_high_fit) * 100, 0)} probabilità high fit</p></article>`).join('') : '<p class="empty">Aumenta N per ottenere una distribuzione visibile.</p>';
}

function blacklistRow(item) { return `<article class="black-row"><div class="champion-cell">${avatar(item)}<div><strong>${esc(item.champion)}</strong><span>${esc(item.role)} · ${item.games_observed} game</span></div></div><div class="black-meta"><b>${item.tier === 'strong' ? 'forte' : 'provv.'}</b><span>${fixed(item.informative_losses_equivalent, 2)} loss inf.</span></div><p>${esc(item.reason)}</p></article>`; }
async function loadBlacklist() {
  const strong = $('#strong-list'); const provisional = $('#provisional-list'); if (!strong && !provisional) return;
  const accountPart = scopedQuery(); const data = await api(`/api/blacklist${accountPart ? `?${accountPart}` : ''}`); const strongItems = data.items.filter((item) => item.tier === 'strong'); const provisionalItems = data.items.filter((item) => item.tier === 'provisional');
  const scope = $('#blacklist-scope'); if (scope) scope.textContent = data.scope_accounts?.length ? `Perimetro attivo: ${data.scope_accounts.length} account selezionati` : 'Perimetro: dataset globale';
  if (strong) strong.innerHTML = strongItems.length ? strongItems.map(blacklistRow).join('') : '<p class="empty">Nessuna esclusione forte.</p>';
  if (provisional) provisional.innerHTML = provisionalItems.length ? provisionalItems.map(blacklistRow).join('') : '<p class="empty">Nessuna esclusione provvisoria.</p>';
  const total = $('#blacklist-total'); if (total) total.textContent = data.items.length;
  const strongCount = $('#strong-count'); if (strongCount) strongCount.textContent = strongItems.length;
  const provisionalCount = $('#provisional-count'); if (provisionalCount) provisionalCount.textContent = provisionalItems.length;
}

async function loadAudit() {
  const list = $('#audit-list'); if (!list) return;
  const flag = $('#audit-flag').value; const accountPart = scopedQuery(); const data = await api(`/api/matches?flag=${encodeURIComponent(flag)}&limit=24${accountPart ? `&${accountPart}` : ''}`);
  list.innerHTML = data.items.length ? data.items.map((item) => `<article class="audit-row" data-match-id="${esc(item.match_id)}"><div class="audit-identity"><time>${new Date(item.date).toLocaleDateString('it-IT')}</time><div class="champion-cell">${avatar(item)}<div>${esc(item.champion)}<small>${esc(item.role)} · ${fixed(item.duration_minutes, 1)} min · ${esc(item.queue)} · ${esc(item.account)}</small></div></div></div><div class="audit-weight"><span class="audit-label">${item.win ? 'Evidenza vittoria' : 'Loss attribuibile al champion'}</span><strong>${item.win ? pct(Number(item.win_evidence_weight) * 100, 0) : pct(Number(item.loss_attribution_weight) * 100, 0)}</strong><small>Qualità match: ${pct(Number(item.match_quality_score) * 100, 0)}</small></div><div class="audit-tags"><span class="audit-label">Cosa è successo</span><span class="flag">${esc(humanizeFlags(item.anomaly_flags))}</span></div><p class="reason"><b>Decisione del modello</b>${esc(humanizeReason(item.reason))}</p><div class="annotation-box"><span class="audit-label">Diario umano</span><div class="annotation-checks"><label><input type="checkbox" data-field="invincible" ${item.annotation_invincible ? 'checked' : ''}> partita invincibile</label><label><input type="checkbox" data-field="carryable_loss" ${item.annotation_carryable_loss ? 'checked' : ''}> loss carryable</label><label><input type="checkbox" data-field="afk_player" ${item.annotation_afk_player ? 'checked' : ''}> AFK</label><label><input type="checkbox" data-field="griefer" ${item.annotation_griefer ? 'checked' : ''}> griefer</label><label><input type="checkbox" data-field="team_collapse" ${item.annotation_team_collapse ? 'checked' : ''}> team collapse</label></div><textarea data-field="note" placeholder="Nota personale: perché questa partita va pesata così?">${esc(item.annotation_note)}</textarea><button type="button" data-save-annotation>Salva annotazione</button><span class="annotation-status"></span></div></article>`).join('') : '<p class="empty">Nessun match per questo filtro.</p>';
}

async function saveAnnotation(button) {
  const row = button.closest('[data-match-id]'); const payload = { match_id: row.dataset.matchId, note: row.querySelector('[data-field="note"]').value };
  row.querySelectorAll('input[data-field]').forEach((input) => { payload[input.dataset.field] = input.checked; });
  button.disabled = true;
  try { await fetch('/api/annotations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); row.querySelector('.annotation-status').textContent = 'salvata'; }
  catch (error) { row.querySelector('.annotation-status').textContent = 'errore'; }
  finally { button.disabled = false; }
}

function profileMetric(value, label) { return `<article class="metric"><b>${esc(value)}</b><span>${esc(label)}</span></article>`; }
function profileBar(item) {
  const title = esc(item.champion || item.role); const games = Number(item.games); const width = Math.min(games / 20 * 100, 100);
  return `<article class="profile-row"><header><strong>${title}</strong><span>${games} game · ${pct(item.win_rate, 0)} win</span></header><div class="profile-rail"><i style="width:${width}%"></i></div></article>`;
}
async function loadProfile() {
  const picker = $('#account-picker'); if (!picker) return;
  const accountsData = await api('/api/accounts');
  const valid = new Set(accountsData.items.map((item) => item.account));
  let selected = readStoredJson(PROFILE_ACCOUNTS_KEY, null);
  const urlAccounts = new URLSearchParams(window.location.search).getAll('account');
  if (urlAccounts.length) selected = urlAccounts;
  if (!selected) selected = accountsData.items.map((item) => item.account);
  selected = selected.filter((account) => valid.has(account));
  if (!selected.length) selected = accountsData.items.map((item) => item.account);
  localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(selected));
  let activeProfile = null;
  const initialGroups = savedProfileGroups();
  activeProfile = Object.keys(initialGroups).find((name) => JSON.stringify(initialGroups[name]) === JSON.stringify(selected)) || null;
  const renderSavedProfiles = () => {
    const groups = savedProfileGroups();
    const container = $('#saved-profiles');
    if (container) container.innerHTML = Object.entries(groups).length ? Object.entries(groups).map(([name, accounts]) => `<button type="button" class="saved-profile ${activeProfile === name ? 'is-active' : ''}" data-profile-name="${esc(name)}"><strong>${esc(name)}</strong><span>${accounts.length} account</span></button>`).join('') : '<p class="empty saved-profile-empty">Nessun profilo salvato. Seleziona gli account e crea il primo.</p>';
    const nameInput = $('#profile-name'); const deleteButton = $('#delete-profile');
    if (nameInput && activeProfile && groups[activeProfile]) nameInput.value = activeProfile;
    if (deleteButton) deleteButton.disabled = !activeProfile || !groups[activeProfile];
  };
  const renderPicker = () => { const count = $('#account-selection-count'); if (count) count.textContent = `${selected.length} di ${accountsData.items.length} selezionati`; picker.innerHTML = `<button id="select-all-accounts" type="button">${selected.length === accountsData.items.length ? 'Deseleziona tutti' : 'Seleziona tutti'}</button>` + accountsData.items.map((item) => `<label class="account-option"><input type="checkbox" value="${esc(item.account)}" ${selected.includes(item.account) ? 'checked' : ''}><span>${esc(item.account)}</span><small>${item.games} game · ${item.analyzed_games || 0} analizzati</small></label>`).join(''); };
  const renderCompanionFilter = () => {
    const select = $('#companion-profile'); const mode = $('#companion-mode'); const status = $('#companion-filter-status');
    if (!select) return;
    const groups = savedProfileGroups();
    const current = (() => { try { return JSON.parse(localStorage.getItem(COMPANION_FILTER_KEY) || 'null'); } catch { return null; } })();
    select.innerHTML = '<option value="">Nessun filtro</option>' + Object.entries(groups).map(([name, group]) => `<option value="${esc(name)}">${esc(name)} · ${group.length} account</option>`).join('');
    if (current && groups[current.name]) { select.value = current.name; mode.value = current.mode; status.textContent = current.mode === 'exclude' ? `Attivo: esclusi i game con ${current.name}.` : `Attivo: mostrati solo i game esclusivi di ${current.name}.`; }
    else status.textContent = 'Nessun filtro di presenza attivo.';
  };
  renderSavedProfiles(); renderPicker(); renderCompanionFilter();
  $('#apply-companion-filter')?.addEventListener('click', async () => {
    const name = $('#companion-profile').value; const groups = savedProfileGroups();
    if (!name || !groups[name]?.length) return;
    const mode = $('#companion-mode').value;
    localStorage.setItem(COMPANION_FILTER_KEY, JSON.stringify({ name, accounts: groups[name], mode }));
    renderCompanionFilter(); await renderProfile(selected);
  });
  $('#clear-companion-filter')?.addEventListener('click', async () => { localStorage.removeItem(COMPANION_FILTER_KEY); renderCompanionFilter(); await renderProfile(selected); });
  const refresh = async () => { const values = [...picker.querySelectorAll('input:checked')].map((input) => input.value); if (values.length) { selected = values; activeProfile = null; localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(values)); renderSavedProfiles(); const count = $('#account-selection-count'); if (count) count.textContent = `${selected.length} di ${accountsData.items.length} selezionati`; const selectAll = $('#select-all-accounts'); if (selectAll) selectAll.textContent = selected.length === accountsData.items.length ? 'Deseleziona tutti' : 'Seleziona tutti'; } await renderProfile(selected); };
  picker.querySelectorAll('input').forEach((input) => input.addEventListener('change', refresh));
  $('#select-all-accounts').addEventListener('click', async () => { const all = selected.length !== accountsData.items.length; picker.querySelectorAll('input').forEach((input) => { input.checked = all; }); selected = all ? accountsData.items.map((item) => item.account) : [accountsData.items[0].account]; activeProfile = null; localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(selected)); renderSavedProfiles(); await renderProfile(selected); });
  const savedProfiles = $('#saved-profiles');
  if (savedProfiles) savedProfiles.addEventListener('click', async (event) => { const button = event.target.closest('[data-profile-name]'); if (!button) return; const groups = savedProfileGroups(); activeProfile = button.dataset.profileName; selected = groups[activeProfile].filter((account) => valid.has(account)); localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(selected)); renderSavedProfiles(); renderPicker(); picker.querySelectorAll('input').forEach((input) => input.addEventListener('change', refresh)); $('#select-all-accounts').addEventListener('click', async () => { const all = selected.length !== accountsData.items.length; picker.querySelectorAll('input').forEach((input) => { input.checked = all; }); selected = all ? accountsData.items.map((item) => item.account) : [accountsData.items[0].account]; activeProfile = null; localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(selected)); renderSavedProfiles(); await renderProfile(selected); }); await renderProfile(selected); });
  const saveForm = $('#save-profile-form');
  if (saveForm) saveForm.addEventListener('submit', async (event) => { event.preventDefault(); const name = $('#profile-name').value.trim(); if (!name || !selected.length) return; const groups = savedProfileGroups(); groups[name] = [...selected]; saveProfileGroups(groups); activeProfile = name; renderSavedProfiles(); await renderProfile(selected); });
  const deleteButton = $('#delete-profile');
  if (deleteButton) deleteButton.addEventListener('click', async () => { if (!activeProfile) return; const groups = savedProfileGroups(); delete groups[activeProfile]; saveProfileGroups(groups); activeProfile = null; $('#profile-name').value = ''; renderSavedProfiles(); });
  await renderProfile(selected);
}
async function renderProfile(accounts) {
  const query = [accounts.map((account) => `account=${encodeURIComponent(account)}`).join('&'), companionQuery()].filter(Boolean).join('&'); const data = await api(`/api/profile?${query}`); const s = data.summary;
  $('#profile-scope').textContent = `${accounts.length} account aggregati`;
  $('#profile-window').textContent = `${s.first_game ? new Date(s.first_game).toLocaleDateString('it-IT') : '—'} → ${s.last_game ? new Date(s.last_game).toLocaleDateString('it-IT') : '—'}`;
  $('#profile-metrics').innerHTML = [profileMetric(s.games, 'game analizzati'), profileMetric(`${s.wins}–${s.losses}`, 'vittorie · sconfitte'), profileMetric(pct(s.win_rate, 1), 'win rate'), profileMetric(s.champions_played, 'champion giocati')].join('');
  $('#profile-champions').innerHTML = data.champions.length ? data.champions.map((item) => profileBar(item)).join('') : '<p class="empty">Nessun dato per la selezione.</p>';
  $('#profile-roles').innerHTML = data.roles.length ? data.roles.map((item) => profileBar(item)).join('') : '<p class="empty">Nessun ruolo valido.</p>';
  $('#profile-recommendations').innerHTML = data.recommendations.length ? data.recommendations.map((item, index) => `<article class="recommendation-card"><span class="card-index">0${index + 1}</span><h3><a class="champion-link" href="/champion.html?champion=${encodeURIComponent(item.champion)}&role=${encodeURIComponent(item.role)}">${esc(item.champion)}</a></h3><span class="pill">${esc(item.role)}</span><strong>${fixed(item.score, 1)}</strong><span class="pill">${esc(item.confidence)}</span><p>${esc(item.reason)}</p></article>`).join('') : '<p class="empty">Non ci sono ancora dati sufficienti per raccomandare un champion.</p>';
  $('#profile-recent').innerHTML = data.recent.length ? data.recent.map((item) => `<article class="recent-row"><span class="recent-result ${item.win ? 'win' : 'loss'}">${item.win ? 'WIN' : 'LOSS'}</span><strong>${esc(item.champion)}</strong><span>${esc(item.role)} · ${esc(item.account)}</span><time>${new Date(item.date).toLocaleDateString('it-IT')}</time></article>`).join('') : '<p class="empty">Nessun match recente.</p>';
}

function friendRow(item, index) {
  const recent = item.last_game ? new Date(item.last_game).toLocaleDateString('it-IT') : '—';
  const accountLabel = Number(item.accounts_played_with) === 1 ? 'account selezionato' : 'account selezionati';
  return `<article class="friend-row"><span class="friend-rank">${String(index + 1).padStart(2, '0')}</span><div><strong>${esc(item.friend)}</strong><span class="friend-with">incontrato con ${esc(item.accounts_played_with)} ${accountLabel}</span></div><b class="friend-games">${esc(item.shared_games)}</b><strong class="friend-win-rate">${pct(Number(item.friend_win_rate), 1)}</strong><span class="friend-last-game">${recent}</span></article>`;
}

function friendSortState() {
  const saved = localStorage.getItem('friends_sort') || 'games:desc';
  const parsed = saved.split(',').map((value) => value.split(':')).filter((parts) => ['games', 'winrate', 'last_game'].includes(parts[0]) && ['asc', 'desc'].includes(parts[1]));
  const unique = [];
  parsed.forEach(([field, direction]) => { if (!unique.some((item) => item[0] === field)) unique.push([field, direction]); });
  return unique.length ? unique : [['games', 'desc']];
}

async function loadFriends() {
  const list = $('#friends-list'); if (!list) return;
  const manualSection = $('#friend-group-form')?.closest('section');
  const rankingSection = list.closest('section');
  if (manualSection && rankingSection && manualSection !== rankingSection) rankingSection.before(manualSection);
  const requestSequence = ++friendsLoadSequence;
  const input = $('#friends-min-games');
  const nameFilter = $('#friends-name-filter');
  const gamesFrom = $('#friends-games-from');
  const lastGameFrom = $('#friends-last-game-from');
  if (!friendsFiltersInitialized) {
    const saved = Number(localStorage.getItem('friends_min_shared_games'));
    if (input && Number.isInteger(saved) && saved >= 1) input.value = saved;
    friendsFiltersInitialized = true;
  }
  const sortState = friendSortState();
  localStorage.setItem('friends_sort', sortState.map(([field, direction]) => `${field}:${direction}`).join(','));
  const minGames = input ? Math.max(1, Math.min(10000, Number(input.value) || 5)) : 5;
  if (input) input.value = minGames;
  const sortQuery = sortState.map(([field, direction]) => `${field}:${direction}`).join(',');
  const [primaryField, primaryDirection] = sortState[0];
  const nameQuery = nameFilter ? nameFilter.value.trim() : '';
  const gamesFromQuery = gamesFrom ? gamesFrom.value : '';
  const lastGameQuery = lastGameFrom ? lastGameFrom.value : '';
  const accountPart = scopedQuery();
  const data = await api(`/api/friends?min_shared_games=${encodeURIComponent(minGames)}&friend_q=${encodeURIComponent(nameQuery)}&games_from=${encodeURIComponent(gamesFromQuery)}&last_game_from=${encodeURIComponent(lastGameQuery)}&sort_by=${encodeURIComponent(primaryField)}&sort_dir=${encodeURIComponent(primaryDirection)}&sort=${encodeURIComponent(sortQuery)}${accountPart ? `&${accountPart}` : ''}&_=${requestSequence}`);
  // A quick second click can finish before the previous request. Never let an
  // older response put the list back in the previous order.
  if (requestSequence !== friendsLoadSequence) return;
  const s = data.summary || {};
  const effectiveMinGames = Number.isInteger(Number(s.min_shared_games)) ? Number(s.min_shared_games) : minGames;
  const normalizedNameQuery = nameQuery.casefold ? nameQuery.casefold() : nameQuery.toLocaleLowerCase();
  const friends = (Array.isArray(data.items) ? data.items : []).filter((item) => Number(item.shared_games) >= effectiveMinGames)
    .filter((item) => !normalizedNameQuery || String(item.friend || '').toLocaleLowerCase().includes(normalizedNameQuery));
  const sortKeys = { games: 'shared_games', winrate: 'friend_win_rate', last_game: 'last_game' };
  friends.sort((left, right) => {
    for (const [field, direction] of sortState) {
      const key = sortKeys[field];
      const leftValue = left[key] ?? '';
      const rightValue = right[key] ?? '';
      if (leftValue === rightValue) continue;
      const comparison = leftValue < rightValue ? -1 : 1;
      return direction === 'asc' ? comparison : -comparison;
    }
    return String(left.friend).localeCompare(String(right.friend));
  });
  $('#friends-metrics').innerHTML = [profileMetric(s.tracked_accounts || 0, 'account aggregati'), profileMetric(s.matches_with_participants || 0, 'match analizzati'), profileMetric(s.friends_found ?? friends.length, `friends filtrati · ≥ ${effectiveMinGames} partite`)].join('');
  list.innerHTML = friends.length ? friends.map(friendRow).join('') : '<p class="empty">Nessuna partita condivisa trovata per questa soglia.</p>';
  document.querySelectorAll('[data-friends-sort]').forEach((button) => {
    const position = sortState.findIndex(([field]) => field === button.dataset.friendsSort);
    const active = position >= 0;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-sort', active ? (sortState[position][1] === 'asc' ? 'ascending' : 'descending') : 'none');
    const indicator = button.querySelector('b');
    if (indicator) indicator.textContent = active ? `${position + 1}${sortState[position][1] === 'asc' ? '↑' : '↓'}` : '↕';
  });
  const groups = $('#friend-groups');
  const manualGroups = Array.isArray(data.manual_groups) ? data.manual_groups : [];
  if (groups) groups.innerHTML = manualGroups.length ? `<div class="friend-groups-heading"><span>Gruppi salvati</span><small>${manualGroups.length} configurat${manualGroups.length === 1 ? 'o' : 'i'}</small></div>${manualGroups.map((group) => `<div class="friend-group"><div class="friend-group-copy"><div class="friend-group-name"><strong>${esc(group.name)}</strong><button type="button" class="friend-group-rename" data-rename-friend-group="${esc(group.id)}" data-friend-group-name="${esc(group.name)}" aria-label="Rinomina ${esc(group.name)}">✎</button></div><div class="friend-group-aliases">${(Array.isArray(group.aliases) ? group.aliases : []).map((alias) => `<span class="friend-group-alias"><span>${esc(alias)}</span><button type="button" class="friend-alias-delete" data-delete-friend-alias="${esc(group.id)}" data-friend-alias="${esc(alias)}" aria-label="Rimuovi ${esc(alias)}">×</button></span>`).join('')}</div></div></div>`).join('')}` : '<p class="empty">Nessun gruppo manuale ancora salvato.</p>';
  const form = $('#friend-group-form');
  if (form && !form.dataset.bound) { form.dataset.bound = '1'; form.addEventListener('submit', async (event) => { event.preventDefault(); const name = $('#friend-group-name').value.trim(); const aliases = $('#friend-group-aliases').value.split(',').map((value) => value.trim()).filter(Boolean); try { await apiPost('/api/friend-groups', {name, aliases}); await loadFriends(); } catch (error) { alert(error.message); } }); }
}
document.addEventListener('click', (event) => {
  const renameGroupButton = event.target.closest('[data-rename-friend-group]');
  if (renameGroupButton) {
    const currentName = renameGroupButton.dataset.friendGroupName || '';
    const nextName = window.prompt('Nuovo nome del gruppo', currentName);
    if (nextName === null) return;
    const name = nextName.trim();
    if (!name || name === currentName) return;
    apiPatch(`/api/friend-groups/${encodeURIComponent(renameGroupButton.dataset.renameFriendGroup)}`, {name})
      .then(loadFriends).catch((error) => alert(error.message));
    return;
  }
  const deleteAliasButton = event.target.closest('[data-delete-friend-alias]');
  if (deleteAliasButton) {
    apiDelete(`/api/friend-groups/${encodeURIComponent(deleteAliasButton.dataset.deleteFriendAlias)}/aliases/${encodeURIComponent(deleteAliasButton.dataset.friendAlias)}`).then(loadFriends).catch((error) => alert(error.message));
    return;
  }
  const deleteGroupButton = event.target.closest('[data-delete-friend-group]');
  if (deleteGroupButton) {
    if (!window.confirm('Rimuovere questo gruppo manuale? Le partite non verranno cancellate.')) return;
    apiDelete(`/api/friend-groups/${encodeURIComponent(deleteGroupButton.dataset.deleteFriendGroup)}`).then(loadFriends).catch((error) => alert(error.message));
    return;
  }
  const sortButton = event.target.closest('[data-friends-sort]');
  if (sortButton) {
    const sortState = friendSortState();
    const field = sortButton.dataset.friendsSort;
    const current = sortState.find((item) => item[0] === field);
    const direction = current && current[1] === 'desc' ? 'asc' : 'desc';
    const nextState = [[field, direction], ...sortState.filter((item) => item[0] !== field)];
    localStorage.setItem('friends_sort', nextState.map(([name, order]) => `${name}:${order}`).join(','));
    loadFriends().catch((error) => { console.error('Friends sort failed', error); });
    return;
  }
  if (event.target.id !== 'reload-friends') return;
  const input = $('#friends-min-games');
  const nameFilter = $('#friends-name-filter');
  const gamesFrom = $('#friends-games-from');
  const lastGameFrom = $('#friends-last-game-from');
  const value = Math.max(1, Math.min(10000, Number(input.value) || 5));
  input.value = value;
  localStorage.setItem('friends_min_shared_games', String(value));
  loadFriends().catch((error) => { console.error('Friends reload failed', error); });
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !event.target.closest('.friends-controls')) return;
  event.preventDefault();
  $('#reload-friends')?.click();
});
async function loadChampionDetail() {
  const title = $('#champion-title'); if (!title) return;
  const query = new URLSearchParams(window.location.search); const champion = query.get('champion') || ''; if (!champion) { title.textContent = 'Champion non specificato'; return; }
  const accounts = readStoredJson(PROFILE_ACCOUNTS_KEY, []); (Array.isArray(accounts) ? accounts : []).forEach((account) => query.append('account', account));
  try { const companion = JSON.parse(localStorage.getItem(COMPANION_FILTER_KEY) || 'null'); if (companion?.accounts?.length && ['exclude', 'only'].includes(companion.mode)) { companion.accounts.forEach((account) => query.append('companion_account', account)); query.set('companion_mode', companion.mode); } } catch (_) { /* ignore malformed local filter */ }
  const data = await api(`/api/champion?${query.toString()}`); const s = data.stats; title.textContent = `${data.champion}.`; $('#champion-copy').textContent = data.fit ? `Fit globale ${pct(data.fit.account_adjusted_fit_score, 1)} · ${data.fit.games_observed} game osservati · intervallo 90% ${interval90(data.fit.credible_lower_90, data.fit.credible_upper_90)}.` : 'Questo champion non ha ancora un fit globale calcolato.'; $('#champion-scope').textContent = accounts.length ? `${accounts.length} account selezionati` : 'tutti gli account del database'; $('#champion-metrics').innerHTML = [profileMetric(s.games, 'game personali'), profileMetric(`${s.wins}–${s.games - s.wins}`, 'vittorie · sconfitte'), profileMetric(pct(s.win_rate, 1), 'win rate personale'), profileMetric(s.invincible_games + s.carryable_losses, 'annotazioni carryability')].join(''); $('#champion-roles').innerHTML = data.roles.length ? data.roles.map((item) => `<article class="profile-row"><header><strong>${esc(item.role)}</strong><span>${item.games_observed} game · ${pct(item.account_adjusted_fit_score, 0)} fit</span></header><div class="profile-rail"><i style="width:${Math.min(Number(item.account_adjusted_fit_score), 100)}%"></i></div><small>Intervallo 90%: ${interval90(item.credible_lower_90, item.credible_upper_90)}</small></article>`).join('') : '<p class="empty">Nessuna evidenza globale.</p>'; $('#champion-annotations').innerHTML = `<article class="profile-row"><header><strong>${s.invincible_games} invincibili</strong><span>${s.carryable_losses} loss carryable</span></header><small>${s.afk_games} con AFK · ${s.griefer_games} con griefer</small></article>`; $('#champion-recent').innerHTML = data.recent.length ? data.recent.map((item) => `<article class="recent-row"><span class="recent-result ${item.win ? 'win' : 'loss'}">${item.win ? 'WIN' : 'LOSS'}</span><strong>${esc(item.role)}</strong><span>${esc(item.account)}</span><time>${new Date(item.date).toLocaleDateString('it-IT')}</time></article>`).join('') : '<p class="empty">Nessun match trovato.</p>';
}

async function loadScreen() {
  const grid = $('#screen-grid'); if (!grid) return;
  const accountPart = scopedQuery(); const data = await api(`/api/screen${accountPart ? `?${accountPart}` : ''}`); grid.innerHTML = data.items.map((item) => `<article class="screen-card"><header>${avatar(item)}<div><strong>${esc(item.champion)}</strong><br><small>${esc(item.role)} · ${pct(Number(item.personalized_prior ?? item.theoretical_fit_prior) * 100, 0)} prior profilo</small></div></header><p>${esc(item.matched_tags || 'Nessun tag disponibile')}</p><span class="screen-reason">${esc(item.classification || 'screening')}</span></article>`).join('');
}

function attachInteractions() {
  const roleFilter = $('#role-filter'); if (roleFilter) roleFilter.addEventListener('change', (event) => { state.role = event.target.value; loadFit(); });
  const statusFilter = $('#status-filter'); if (statusFilter) statusFilter.addEventListener('change', (event) => { state.status = event.target.value; loadFit(); });
  const search = $('#search-filter'); if (search) { let timer; search.addEventListener('input', (event) => { clearTimeout(timer); timer = setTimeout(() => { state.search = event.target.value; loadFit(); }, 180); }); }
  const reloadAudit = $('#reload-audit'); if (reloadAudit) reloadAudit.addEventListener('click', loadAudit);
  const auditFlag = $('#audit-flag'); if (auditFlag) auditFlag.addEventListener('change', loadAudit);
  const auditList = $('#audit-list'); if (auditList) auditList.addEventListener('click', (event) => { if (event.target.matches('[data-save-annotation]')) saveAnnotation(event.target); });
  const planInput = $('#plan-n');
  if (planInput) { const refresh = () => { const value = Math.min(Math.max(Number(planInput.value) || 400, 20), 2000); planInput.value = value; loadPlan(value); }; planInput.addEventListener('change', refresh); planInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') refresh(); }); document.querySelectorAll('[data-n]').forEach((button) => button.addEventListener('click', () => { planInput.value = button.dataset.n; refresh(); })); }
  const planRole = $('#plan-role'); if (planRole) planRole.addEventListener('change', () => loadPlan($('#plan-n')?.value || ''));
}

async function boot() {
  setActiveNav();
  loadSyncStatus();
  window.setInterval(loadSyncStatus, 30000);
  try { await loadGlobalAccountPicker(); const accountPart = scopedQuery(); const overview = await api(`/api/overview${accountPart ? `?${accountPart}` : ''}`); renderOverview(overview); await Promise.all([loadFit(), loadPlan($('#plan-n')?.value || ''), loadBlacklist(), loadAudit(), loadScreen(), loadProfile(), loadChampionDetail(), loadFriends()]); attachInteractions(); }
  catch (error) { const main = document.querySelector('main'); if (main) main.insertAdjacentHTML('afterbegin', `<div class="error-banner"><b>Il database non è raggiungibile.</b><span>${esc(error.message)}</span></div>`); }
}
boot();
