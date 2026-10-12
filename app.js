'use strict';
(() => {
  const APP_VERSION = '2026-10-12.6';
  const MIN_PHOTOS = 2, MAX_PHOTOS = 4, MAX_FILE_MB = 40, MAX_EDGE = 1600, PHOTO_TTL_MS = 24 * 3600 * 1000;
  const SKEY = 'yokohama-sodai:v5';
  const L$ = window.SodaiLogic, G = window.SodaiGrokGuide;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = L$.yen;
  const nk = s => String(s ?? '').normalize('NFKC');
  const telHref = n => 'tel:' + String(n).replace(/[^\d]/g, '');
  const POPULAR = ['たんす', 'ソファー(2人以上用)', 'ベッド(枠のみ)', '自転車(子供用自転車を含む)', '布団&マットレス(2枚まで1組に)', '食器棚', 'テーブル', 'いす', 'カーペット類', '電子レンジ'];
  const POP_LABEL = { 'ソファー(2人以上用)': 'ソファー', 'ベッド(枠のみ)': 'ベッド', '自転車(子供用自転車を含む)': '自転車', '布団&マットレス(2枚まで1組に)': '布団', 'カーペット類': 'カーペット' };

  // 永続化する入力（写真以外）
  const S = { screen: 'home', route: 'name', q: '', groupKey: null, naKey: null, notInList: false, longest: '', dims: { d: '', w: '', h: '' }, mat: null, variantMat: null, bat: null, batDamaged: false, bkind: null, bDamaged: false, count: 1, method: 'collect', carry: null, grokReply: '', wiz: 1, candidates: null, keepPhotos: false };
  const D = { fees: null, rules: null, groups: [], fromCache: false, photos: [] };

  // ---------- データ読み込み（形が正しいものだけ使う） ----------
  async function loadJSON(url, valid) {
    let fromCache = false;
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      fromCache = res.headers.get('x-sodai-cache') === '1';
      if (res.ok) { const j = await res.json(); if (valid(j)) return { data: j, fromCache }; }
    } catch { /* 下で保存済みを探す */ }
    if (window.caches) {
      const hit = await caches.match(url, { ignoreSearch: true });
      if (hit) { try { const j = await hit.json(); if (valid(j)) return { data: j, fromCache: true }; } catch { /* 無効 */ } }
    }
    throw new Error(url + ' を読み込めませんでした');
  }

  async function init() {
    const saved = readSaved(); // 他の処理が保存し直す前に読む
    $('#appVersion').textContent = APP_VERSION;
    $$('.maxPhotos').forEach(e => e.textContent = MAX_PHOTOS);
    try {
      const [f, r] = await Promise.all([loadJSON('data/fees.json', L$.validFees), loadJSON('data/rules.json', L$.validRules)]);
      D.fees = f.data; D.rules = r.data; D.fromCache = f.fromCache || r.fromCache;
      D.groups = L$.buildGroups(D.fees);
    } catch (e) {
      $('#main').insertAdjacentHTML('afterbegin', `<div class="card warn">データを読み込めませんでした。通信状態を確認して再読み込みしてください。<br>${esc(e.message)}</div>`);
      return;
    }
    $('#dataDate').textContent = D.fees.retrievedAt;
    $('#itemCount').textContent = D.fees.items.length;
    renderNotices(); renderPopular(); renderNA(); setupGrok(); bind(); setupSW();
    purgeOldPhotos();
    if (saved && saved.screen && saved.screen !== 'home') { $('#resumeBar').hidden = false; $('#resumeBtn').onclick = () => resume(saved); $('#freshBtn').onclick = () => { clearSaved(); $('#resumeBar').hidden = true; }; }
    history.replaceState({ screen: 'home', idx: 0 }, '');
    show('home', false);
    window.addEventListener('popstate', e => show(clamp((e.state && e.state.screen) || 'home'), false));
  }

  // ---------- 保存・再開 ----------
  function save() { try { sessionStorage.setItem(SKEY, JSON.stringify({ ...S, savedAt: Date.now() })); } catch { /* 容量など */ } }
  function readSaved() { try { return JSON.parse(sessionStorage.getItem(SKEY) || 'null'); } catch { return null; } }
  function clearSaved() { try { sessionStorage.removeItem(SKEY); } catch { /* */ } }
  async function resume(saved) {
    Object.assign(S, saved, { dims: { ...S.dims, ...(saved.dims || {}) } });
    $('#resumeBar').hidden = true;
    $('#keepPhotos').checked = !!S.keepPhotos;
    if (S.keepPhotos) await restorePhotos();
    $('#q').value = S.q || '';
    $('#dimD').value = S.dims.d || ''; $('#dimW').value = S.dims.w || ''; $('#dimH').value = S.dims.h || '';
    $('#grokReply').value = S.grokReply || '';
    if (S.grokReply) parseGrok(true);
    renderThumbs(); renderResults();
    const target = clamp(S.screen);
    if (target !== 'home') history.pushState({ screen: target, idx: 1 }, '');
    show(target, false);
    toast('前回の続きから再開しました');
  }

  // ---------- 画面遷移 ----------
  const group = () => S.naKey ? naGroup(S.naKey) : (S.groupKey ? D.groups.find(g => g.baseName === S.groupKey) : null);
  function clamp(sc) {
    const g = group();
    if (['size', 'result', 'battery'].includes(sc) && !g && !S.notInList) return S.route === 'photo' ? 'photo' : 'item';
    if (sc === 'battery' && !(g && g.isBattery)) return 'item';
    if (sc === 'result' && !(g && g.notAccepted) && !(lengthCm() > 0)) return 'size';
    return sc;
  }
  function go(sc) {
    sc = clamp(sc);
    const idx = (history.state && history.state.idx || 0) + 1;
    history.pushState({ screen: sc, idx }, '');
    show(sc, true);
  }
  function back() { if (history.state && history.state.idx > 0) history.back(); else show('home', true); }
  function show(sc, focus) {
    S.screen = sc; save();
    $$('.screen').forEach(s => s.hidden = s.id !== 's-' + sc);
    if (sc === 'item') renderResults();
    if (sc === 'size') prepSize();
    if (sc === 'result') renderResult();
    if (sc === 'battery') renderBattery();
    renderStepInd();
    $('#notices').hidden = !['home', 'result', 'battery'].includes(sc);
    window.scrollTo(0, 0);
    if (focus !== false) { const h = $(`#s-${sc} h2`); if (h) h.focus({ preventScroll: true }); }
  }
  function renderStepInd() {
    const seq = S.route === 'photo' ? ['photo', 'item', 'size', 'result'] : ['item', 'size', 'result'];
    const names = { photo: '写真', item: '品目', size: '大きさ', result: '結果' };
    const sc = S.screen === 'battery' ? 'size' : S.screen === 'home' ? (S.route === 'photo' ? 'photo' : 'item') : S.screen;
    const i = seq.indexOf(sc);
    const el = $('#stepInd');
    if (S.screen === 'home' || i < 0) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = `全${seq.length}手順の${'①②③④'[i]} ${names[sc]}`;
  }

  // ---------- お知らせ ----------
  function renderNotices() {
    const list = L$.activeNotices(D.rules, new Date());
    let h = list.map(n => `<div class="notice ${n.level === 'warn' ? 'warn' : ''}" role="note"><p>${esc(n.text)}</p><a href="${esc(n.url)}" target="_blank" rel="noopener">横浜市の案内を見る ↗</a></div>`).join('');
    if (D.fromCache || !navigator.onLine) h += `<div class="notice warn" role="note"><p>オフラインまたは通信エラーのため、この端末に保存済みのデータ（取得日 ${esc(D.fees.retrievedAt)}）で表示しています。</p></div>`;
    $('#notices').innerHTML = h;
  }

  // ---------- ホーム・検索 ----------
  function renderPopular() {
    $('#popular').innerHTML = POPULAR.filter(b => D.groups.some(g => g.baseName === b)).map(b => `<button type="button" class="chip" data-g="${esc(b)}">${esc(POP_LABEL[b] || b)}</button>`).join('');
    $$('#popular .chip').forEach(b => b.addEventListener('click', () => { S.route = 'name'; selectGroup(b.dataset.g); }));
  }
  function feeText(g) {
    if (g.notAccepted) return '<span class="fee na">市で回収不可</span>';
    if (g.minFee == null) return '';
    return `<span class="fee">${g.minFee === g.maxFee ? yen(g.minFee) : yen(g.minFee) + '〜' + yen(g.maxFee)}</span>`;
  }
  function itemBtn(g, attr) {
    return `<button type="button" class="row" role="listitem" ${attr}><span class="nm">${esc(g.baseName)}${g.keywords.length ? `<span class="kw">${esc(g.keywords.slice(0, 3).join('、'))}</span>` : ''}</span>${feeText(g)}</button>`;
  }
  function renderResults() {
    const q = $('#q').value.trim();
    S.q = q;
    let list = q ? L$.search(D.groups, q) : POPULAR.map(b => D.groups.find(g => g.baseName === b)).filter(Boolean);
    const box = $('#results'), MAX = 60;
    box.innerHTML = list.slice(0, MAX).map(g => itemBtn(g, `data-g="${esc(g.baseName)}"`)).join('');
    $$('#results .row').forEach(b => b.addEventListener('click', () => selectGroup(b.dataset.g)));
    $('#resultCount').textContent = q ? (list.length ? `「${q}」の候補 ${list.length}件${list.length > MAX ? `（上位${MAX}件を表示）` : ''}` : '') : 'よく出される物（名前を入力すると全品目から探します）';
    const nh = $('#noHit');
    nh.hidden = !(q && !list.length);
    if (!nh.hidden) {
      const rc = D.rules.reception;
      nh.innerHTML = `<p><b>「${esc(q)}」は見つかりませんでした。</b>別の言い方（例：ソファ→ソファー）でも探してみてください。わからない時は電話で確認できます。</p>
        <a class="btn primary big wide" href="${telHref(rc.phoneLandline)}">📞 粗大ごみ受付センター ${esc(rc.phoneLandline)}</a>
        <a class="btn wide" href="${telHref(rc.phoneMobileIp)}">📱 携帯・IP電話から ${esc(rc.phoneMobileIp)}</a>
        <p class="hint">${esc(rc.phoneHours)}</p>`;
    }
    save();
  }
  function naGroup(key) {
    const n = D.rules.notAccepted.find(x => x.key === key); if (!n) return null;
    return { baseName: n.label, notAccepted: true, items: [], materials: [], keywords: [], naRule: n, isBattery: !!n.battery };
  }
  function renderNA() {
    $('#naList').innerHTML = D.rules.notAccepted.map(n => `<button type="button" class="row" role="listitem" data-na="${esc(n.key)}"><span class="nm">${esc(n.label)}</span><span class="fee na">市で回収不可</span></button>`).join('');
    $$('#naList .row').forEach(b => b.addEventListener('click', () => selectNA(b.dataset.na)));
  }
  function resetInputs() {
    Object.assign(S, { mat: null, variantMat: null, bat: null, batDamaged: false, count: 1, carry: null, bkind: null, bDamaged: false });
  }
  function selectGroup(baseName) {
    const g = D.groups.find(x => x.baseName === baseName); if (!g) return;
    if (S.groupKey !== baseName) resetInputs();
    S.groupKey = baseName; S.naKey = null; S.notInList = false;
    if (g.notAccepted) {
      const rule = D.rules.notAccepted.find(n => n.match.some(m => g.baseName.includes(m)));
      if (rule && rule.battery) { S.naKey = rule.key; S.groupKey = null; return go('battery'); }
      return go('result'); // 収集対象外：寸法は聞かずに案内へ
    }
    go('size');
  }
  function selectNA(key) {
    resetInputs(); S.naKey = key; S.groupKey = null; S.notInList = false;
    go(naGroup(key).isBattery ? 'battery' : 'result');
  }

  // ---------- 大きさ ----------
  function lengthCm() { const v = G.parseLengthCm(S.longest); return v > 0 && v <= 1000 ? v : null; }
  function prepSize() {
    const g = group();
    $('#sizeItem').innerHTML = S.notInList ? '品目：<b>一覧にない物</b>' : `品目：<b>${esc(g.baseName)}</b>`;
    $('#itemNotes').innerHTML = g ? notesHtml(g) : '';
    $('#dimD').value = S.dims.d; $('#dimW').value = S.dims.w; $('#dimH').value = S.dims.h;
    $$('input[name=mat]').forEach(r => r.checked = r.value === S.mat);
    $$('input[name=bat]').forEach(r => r.checked = r.value === S.bat);
    $('#batDamaged').checked = !!S.batDamaged;
    $('#batQ').hidden = !(g && g.batteryNote);
    updateSizeUI(false);
  }
  function notesHtml(g) {
    const notes = [...new Set(g.items.map(i => i.note).filter(Boolean))];
    if (!notes.length) return '';
    return `<div class="notes"><p class="lead">品目一覧の注意書き</p>${notes.map(n => `<p>${esc(n)}</p>`).join('')}</div>`;
  }
  function readSize() {
    S.dims = { d: $('#dimD').value.trim(), w: $('#dimW').value.trim(), h: $('#dimH').value.trim() };
    const dc = dimsCm(); S.longest = [dc.d, dc.w, dc.h].every(v => v > 0) ? String(Math.max(dc.d, dc.w, dc.h)) : '';
    S.mat = ($('input[name=mat]:checked') || {}).value || null;
    S.bat = ($('input[name=bat]:checked') || {}).value || null;
    S.batDamaged = $('#batDamaged').checked;
    const v = ($('input[name=variant]:checked') || {}).value; S.variantMat = v || null;
  }
  function dimsCm() { const p = G.parseLengthCm; return { d: p(S.dims.d), w: p(S.dims.w), h: p(S.dims.h) }; }
  function updateSizeUI(strict) {
    readSize();
    const g = group(), L = lengthCm(), errs = [];
    const names = { d: '縦', w: '横', h: '高さ' }, dd = dimsCm();
    for (const k of ['d', 'w', 'h']) {
      const raw = S.dims[k], v = dd[k]; let bad = false;
      if (!raw) { if (strict) { errs.push(`${names[k]}を入力してください`); bad = true; } }
      else if (v == null) { errs.push(`${names[k]}は数字で入力してください（例：120、1.2m）`); bad = true; }
      else if (v <= 0 || v > 1000) { errs.push(`${names[k]}は0より大きく1000cm以下で入力してください`); bad = true; }
      $({ d: '#dimD', w: '#dimW', h: '#dimH' }[k]).classList.toggle('invalid', bad);
    }
    $('#longestOut').textContent = L ? `${L}cm` : '—';
    const ok = L > 0 && L <= 1000;
    const ask = ok && L$.needsMaterialQuestion(S.notInList ? null : g, L, D.rules, S.mat === 'unknown' ? null : S.mat);
    $('#matQ').hidden = !(ok && (ask || S.mat) && L >= D.rules.definition.metalThresholdCm && L < D.rules.definition.nonMetalThresholdCm && (S.notInList || L$.thresholdClass(g, null) === 'ask'));
    if (strict && !$('#matQ').hidden && !S.mat) errs.push('主な素材を選んでください');
    // 区分（素材違いで品目名が分かれる場合）
    renderVariantQ(g, ok ? L : null);
    if (strict && !$('#batQ').hidden && !S.bat) errs.push('バッテリーについて選んでください');
    // 境界の近く
    const near = ok ? L$.nearBoundaries(L, S.notInList ? null : g, D.rules, L$.thresholdClass(S.notInList ? null : g, S.mat)) : [];
    const nw = $('#nearWarn'); nw.hidden = !near.length;
    if (near.length) nw.textContent = `⚠ ${L}cmは基準（${near.map(t => t + 'cm').join('・')}）に近いため、結果が変わることがあります。もう一度測り直してください。`;
    $('#sizeError').textContent = strict ? errs.join(' / ') : errs.filter(e => !/入力してください$|選んでください$/.test(e)).join(' / ');
    save();
    return errs.length === 0 && ok;
  }
  function renderVariantQ(g, L) {
    const box = $('#varQ');
    if (!g || S.notInList || L == null) { box.hidden = true; return; }
    const r = L$.determine({ group: g, L, materialAns: S.mat === 'unknown' ? null : S.mat, battery: batteryInput() }, D.rules);
    const cands = r.type === 'sodai' && !r.variant && !r.forcedMetal ? r.cands : (r.type === 'sodai' && r.forcedMetal && r.cands.length > 1 ? r.cands : null);
    if (!cands || cands.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    const opts = cands.map(c => `<label class="opt"><input type="radio" name="variant" value="${esc(c.materialLabel || c.material)}"${S.variantMat === (c.materialLabel || c.material) ? ' checked' : ''}> ${esc(nk(c.officialName))}（${yen(c.feeYen)}）</label>`).join('');
    $('#varOpts').innerHTML = `<p class="hint">素材によって品目名が分かれています。${r.feeSame ? '手数料はどれも同じです。わからなければ選ばなくても進めます（申込み時に選びます）。' : '手数料が違うので、わかる場合は選んでください。'}</p>` + opts;
    $$('#varOpts input').forEach(i => i.addEventListener('change', () => { readSize(); save(); }));
  }
  function batteryInput() { return S.bat ? { has: S.bat !== 'none', removable: S.bat === 'removable', damaged: !!S.batDamaged } : null; }

  // ---------- 判定結果 ----------
  function src(urls) { return `<p class="src">出典：${[].concat(urls).filter(Boolean).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join('<br>')}</p>`; }
  function phoneBlock(big) {
    const rc = D.rules.reception;
    return `<div class="phone">
      <a class="btn ${big ? 'primary big' : ''} wide" href="${telHref(rc.phoneLandline)}">📞 ${esc(rc.phoneLandline)}（粗大ごみ受付センター）</a>
      <a class="btn wide" href="${telHref(rc.phoneMobileIp)}">📱 ${esc(rc.phoneMobileIp)}（携帯・IP電話から）</a>
      <button type="button" class="btn ghost wide" data-copy="${esc(rc.phoneLandline + ' / ' + rc.phoneMobileIp)}">番号をコピー</button>
      <p class="hint">受付時間：${esc(rc.phoneHours)}</p></div>`;
  }
  function dataLine() { return `<p class="hint">データ取得日：${esc(D.fees.retrievedAt)}（横浜市の品目一覧）。${D.fromCache || !navigator.onLine ? '<b>オフラインのため保存済みデータで表示中。</b>' : ''}</p>`; }
  function finalCheck(name) {
    const rc = D.rules.reception;
    return `<div class="final"><a class="btn wide" href="${esc(rc.itemListUrl)}" target="_blank" rel="noopener" data-copyname="${esc(name)}">公式品目一覧で最終確認 ↗</a><p class="hint">タップすると品目名「${esc(name)}」をコピーしてから開きます。検索欄に貼り付けてください。</p>${dataLine()}</div>`;
  }
  function verdict(cls, title, body) { return `<div class="verdict ${cls}"><p class="big">${title}</p>${body || ''}</div>`; }

  function renderResult() {
    const g = group(), R = D.rules, box = $('#resultBox');
    let h = '';
    if (g && g.notAccepted) { box.innerHTML = naHtml(g); wireResult(); return; }
    const L = lengthCm();
    const r = L$.determine({ group: S.notInList ? null : g, notInList: S.notInList, L, materialAns: S.mat === 'unknown' ? null : S.mat, variantMaterial: S.variantMat, battery: batteryInput() }, R);
    const nearW = r.near && r.near.length ? `<div class="warn">⚠ 一番長い辺 ${L}cm は基準（${r.near.map(t => t + 'cm').join('・')}）に近いため、測り直してください。</div>` : '';
    const notes = g && !S.notInList ? notesHtml(g) : '';
    if (r.type === 'ask-material' || (S.mat === 'unknown' && L >= R.definition.metalThresholdCm && L < R.definition.nonMetalThresholdCm && (S.notInList || L$.thresholdClass(g, null) === 'ask'))) {
      h += verdict('unk', 'このアプリでは確定できません', `<p>一番長い辺が${L}cmの場合、金属製品なら粗大ごみ、それ以外なら家庭ごみです。素材がわからない時は電話で確認してください。</p>`) + phoneBlock(true) + notes;
    } else if (r.type === 'unknown') {
      h += verdict('unk', 'このアプリでは確定できません。電話で確認してください', `<p>品目一覧にない物は、粗大ごみかどうか・手数料をこのアプリでは判断できません（品目一覧にない物はネットでは申し込めず、電話で受け付けています）。</p><p class="hint">参考：横浜市の基準では、一番長い辺が金属製品で30cm以上、それ以外で50cm以上が粗大ごみです（入力：${L}cm）。</p>`) + nearW + phoneBlock(true);
    } else if (r.type === 'small') {
      h += verdict('no', '粗大ごみではない可能性が高いです', `<p>一番長い辺 ${L}cm。横浜市の基準（${r.cls === 'metal' ? '金属製品は30cm以上' : 'それ以外は50cm以上'}）より小さいため、家庭ごみ・資源物として分別して出します。</p>`) + nearW + notes + batteryHtml(g, r, false)
        + `<div class="linkbtns"><a class="btn primary big wide" href="${esc(R.smallItemGuide.url)}" target="_blank" rel="noopener">ごみの分け方を調べる（横浜市）↗</a></div>`
        + `<details class="more"><summary>迷ったら電話で確認</summary>${phoneBlock(false)}</details>` + src([R.definition.source, R.smallItemGuide.url]);
    } else if (r.type === 'phone') {
      h += verdict('unk', 'このアプリでは確定できません。電話で確認してください', `<p>${esc(r.reason)}。</p>`) + nearW + notes + phoneBlock(true);
    } else if (r.type === 'sodai') {
      h += sodaiHtml(g, r, L, nearW, notes);
    }
    if (r.type !== 'sodai') h += finalCheck(g ? g.baseName : '') + src(D.fees.source.url);
    box.innerHTML = h; wireResult(r);
  }

  function naHtml(g) {
    const rule = g.naRule || D.rules.notAccepted.find(n => n.match.some(m => g.baseName.includes(m)));
    const item = g.items && g.items[0];
    let h = verdict('na', '✕ 粗大ごみとして出せません', `<p>「${esc(g.baseName)}」は横浜市では粗大ごみとして回収できません。</p>`);
    if (item && item.note) h += `<div class="notes"><p class="lead">品目一覧の注意書き</p><p>${esc(item.note.replace(/\s*こちら$/, ''))}</p></div>`;
    if (rule) h += `<h3>処分方法</h3><p>${esc(rule.guidance)}</p><a class="btn primary big wide" href="${esc(rule.url)}" target="_blank" rel="noopener">処分方法を公式ページで見る ↗</a>${src(rule.url)}`;
    else if (item) h += item.links.map(u => `<a class="btn primary wide" href="${esc(u)}" target="_blank" rel="noopener">処分方法を公式ページで見る ↗</a>`).join('') + src(item.links);
    h += `<details class="more"><summary>わからない時は電話で確認</summary>${phoneBlock(false)}</details>` + finalCheck(g.baseName);
    return h;
  }

  function batteryHtml(g, r, sodai) {
    if (!g || !g.batteryNote) return '';
    const B = D.rules.battery, b = batteryInput();
    let t;
    if (!b || !b.has) t = 'バッテリーが付いている場合は、出し方が変わります。';
    else if (b.removable) t = (b.damaged ? B.damaged : 'バッテリーは外して、家庭ごみの「電池類」へ出します。' + B.small);
    else t = sodai ? (b.damaged ? 'バッテリーが破損・膨張している場合は、申し込む前に粗大ごみ受付センターへ相談してください。' : '本体の材質に関わらず「資）」の品目で申し込み、バッテリーは付けたまま出します。') : (b.damaged ? B.damaged : B.builtInSmall);
    return `<div class="notes bat"><p class="lead">🔋 バッテリー</p><p>${esc(t)}</p>${src(B.sources[0])}</div>`;
  }

  function sodaiHtml(g, r, L, nearW, notes) {
    const R = D.rules, rc = R.reception;
    const v = r.variant;
    const base = v || r.cands[0];
    const fee = L$.computeFee(base, S.count);
    const feeUncertain = !v && !r.feeSame;
    const self = S.method === 'self';
    const limit = self ? R.selfDelivery.maxItemsPerDay : R.collection.maxItems;
    let h = verdict('yes', '◯ 粗大ごみです', `<p>一番長い辺 ${L}cm（基準：${r.cls === 'metal' ? '金属製品は30cm以上' : 'それ以外は50cm以上'}）</p>`) + nearW;
    if (r.battery && r.battery.has && !r.battery.removable && r.battery.damaged) h += `<div class="warn">🔋 バッテリーが破損・膨張しているため、申し込む前に粗大ごみ受付センターへ相談してください。</div>`;
    h += `<div class="feebox">
      <p class="lead">手数料の目安</p>
      ${feeUncertain ? `<p>素材によって ${r.cands.map(c => esc(nk(c.officialName)) + ' ' + yen(c.feeYen)).join(' / ')}。前の画面で区分を選ぶと計算できます。</p>` : `
      <p class="fee-big">${yen(fee.totalYen)}<small>（目安）</small></p>
      <p>${esc(fee.formula)}</p>
      <p class="hint">${yen(fee.unitYen)}は${esc(fee.unitLabel)}。${fee.condition ? esc(fee.condition) + '。' : ''}収集・持込みとも同じ手数料です。</p>`}
      <label class="qty" for="count">数</label>
      <div class="stepper-in"><button type="button" class="btn" data-cnt="-1" aria-label="1つ減らす">－</button><input id="count" type="number" inputmode="numeric" min="1" max="99" value="${fee.count}" aria-describedby="countUnit"><span id="countUnit">${esc(fee.unit)}</span><button type="button" class="btn" data-cnt="1" aria-label="1つ増やす">＋</button></div>
      ${fee.sets > limit ? `<div class="warn">${self ? `持込みは1日${limit}個まで（栄ストックヤードの簡易申込みは${R.selfDelivery.sakaeSimpleMaxItems}個まで）` : `収集は1回の申込みで${limit}個まで`}です。分けて申し込んでください。</div>` : ''}
      <p class="hint">${v ? '品目一覧の品目名：<b>' + esc(nk(v.officialName)) + '</b>' : '申込み時に区分（' + r.cands.map(c => esc(nk(c.officialName))).join(' / ') + '）を選びます'}</p>
      <p class="hint"><b>シール（または電子決済）は、申し込みで金額が確定してから</b>支払ってください。表示は${esc(D.fees.retrievedAt)}時点の目安です。</p>
    </div>`;
    h += notes + batteryHtml(g, r, true);
    h += `<div class="tabs" role="group" aria-label="出し方"><button type="button" data-m="collect" aria-pressed="${!self}">自宅前などで収集</button><button type="button" data-m="self" aria-pressed="${self}">自分で持ち込む</button></div>`;
    h += `<div class="apply"><p class="done-not">⚠ ここでは申し込みは完了していません。下のどれかで申し込んでください。</p>
      <a class="btn primary big wide" href="${esc(rc.internetUrl)}" target="_blank" rel="noopener">インターネットで申し込む（24時間）↗</a>
      <details class="more"><summary>ほかの方法（LINE・チャット・電話）</summary>
        <a class="btn line wide" href="${esc(rc.lineAddFriendUrl)}" target="_blank" rel="noopener">横浜市のLINEを開く ↗</a>
        <p class="hint">横浜市LINE公式アカウント（${esc(rc.lineId)}）のメニュー「粗大ごみ」から申し込めます。</p>
        <a class="btn wide" href="${esc(rc.chatUrl)}" target="_blank" rel="noopener">チャットで申し込む ↗</a>
        ${phoneBlock(false)}
        ${src([rc.source, rc.lineSource, rc.lineInfoUrl])}
      </details></div>`;
    const memo = feeUncertain ? L$.buildMemo({ group: g, variant: null, cands: r.cands, fee: null, dims: dimsCm(), L, method: S.method, rules: R, retrievedAt: D.fees.retrievedAt })
      : L$.buildMemo({ group: g, variant: v, cands: r.cands, fee, dims: dimsCm(), L, method: S.method, rules: R, retrievedAt: D.fees.retrievedAt });
    h += `<div class="memo-box"><p class="lead">申し込みで聞かれること</p><pre id="memo" class="memo">${esc(memo)}</pre><button type="button" id="copyMemo" class="btn wide">📋 メモをコピー</button></div>`;
    h += self ? procSelf(fee, feeUncertain) : procCollect(fee, feeUncertain);
    h += `<div class="q carry"><p class="lead">自分で外まで運べますか？</p><div class="btnrow"><button type="button" class="btn" data-carry="yes" aria-pressed="${S.carry === 'yes'}">はい</button><button type="button" class="btn" data-carry="no" aria-pressed="${S.carry === 'no'}">いいえ・難しい</button></div><div id="supportBox">${S.carry === 'no' ? supportHtml() : ''}</div></div>`;
    h += finalCheck(v ? nk(v.officialName).replace(/^[可資不][)）]/, '') : g.baseName) + src(D.fees.source.url);
    return h;
  }

  function supportHtml() {
    const s = D.rules.support;
    return `<div class="notes"><p><b>${esc(s.carryOut.title)}</b>：${esc(s.carryOut.text)}</p><p class="hint">${esc(s.carryOut.targetsSummary)}</p>
      <a class="btn wide" href="${esc(s.carryOut.url)}" target="_blank" rel="noopener">持ち出し収集の条件を見る ↗</a>
      <a class="btn wide" href="${esc(D.rules.reception.jimushoUrl)}" target="_blank" rel="noopener">区の資源循環局事務所の電話番号 ↗</a>
      <p><b>${esc(s.exemption.title)}</b>：${esc(s.exemption.text)}</p>
      <a class="btn wide" href="${esc(s.exemption.url)}" target="_blank" rel="noopener">減免の対象を見る ↗</a>
      <p class="hint">利用できるかどうかは条件によります。このアプリでは判断できません。</p></div>`;
  }
  function procCollect(fee, unc) {
    const R = D.rules, c = R.collection, p = R.payment;
    return `<h3>収集の流れ</h3><ol class="steps">
      <li><b>申し込む</b>収集日の7日前まで（例：火曜収集なら前週の月曜まで）。受付から収集まで2週間程度。1回の申込みは${c.maxItems}個まで。家庭から出るものだけが対象です。受付番号（6桁）と収集日を控えます。</li>
      <li><b>手数料を払う（金額が確定してから）</b>
        <ul class="sub"><li>粗大ごみ収集シールを市内の指定金融機関・郵便局・コンビニ（${esc(p.convenienceStores.join('、'))}）で${!unc && fee ? yen(fee.totalYen) + '分' : '手数料分'}購入。領収書は収集が終わるまで保管。</li>
        <li>電子決済（インターネット・チャット・LINEで申し込んだ場合のみ）：クレジットカード・PayPay。本受付完了メールの決済URLから収集日の3営業日前までに。電話申込みでは使えません。</li></ul></li>
      <li><b>当日</b>シールの<b>氏名欄に受付番号（6桁）と収集日</b>を記入して貼り、<b>収集日の朝8時まで</b>に申込み時に確認した場所へ。電子決済の場合は縦横10cm以上の紙に受付番号6桁と収集日を書き、テープで4辺を貼ります。雨でも収集します（油性ペンで記入）。</li>
    </ol>${src([...c.sources, ...p.sources])}`;
  }
  function procSelf(fee, unc) {
    const S2 = D.rules.selfDelivery;
    return `<h3>持ち込みの流れ</h3><ol class="steps">
      <li><b>申し込む</b>インターネット受付は搬入日当日15時まで。1日${S2.maxItemsPerDay}個まで（栄ストックヤードの簡易申込みは${S2.sakaeSimpleMaxItems}個まで）。家庭から出るものだけが対象です。</li>
      <li><b>手数料を払う（金額が確定してから）</b>収集と同じ手数料${!unc && fee ? '（目安 ' + yen(fee.totalYen) + '）' : ''}。粗大ごみ収集シールを事前に購入（ヤードでは販売していません）。</li>
      <li><b>持ち込む</b>申し込んだ日時・施設へ。9時より前は入場できません。原則申込者本人が持込み（本人以外は委任状）、荷下ろしは自分で。
        <ul class="sub">${S2.yards.map(y => `<li>${esc(y.name)}：${esc(y.address)}（${esc(y.hours)}／休み：${esc(y.closed)}）</li>`).join('')}</ul></li>
    </ol>${src(S2.sources)}`;
  }

  function wireResult() {
    const box = $('#resultBox');
    $$('[data-m]', box).forEach(b => b.addEventListener('click', () => { S.method = b.dataset.m; save(); renderResult(); }));
    $$('[data-cnt]', box).forEach(b => b.addEventListener('click', () => { S.count = Math.min(99, Math.max(1, (Number(S.count) || 1) + Number(b.dataset.cnt))); save(); renderResult(); $('#count')?.focus(); }));
    const cnt = $('#count', box);
    if (cnt) cnt.addEventListener('change', () => { const n = Math.floor(Number(cnt.value)); S.count = n >= 1 && n <= 99 ? n : 1; save(); renderResult(); });
    $$('[data-carry]', box).forEach(b => b.addEventListener('click', () => { S.carry = b.dataset.carry; save(); $$('[data-carry]', box).forEach(x => x.setAttribute('aria-pressed', x === b)); $('#supportBox').innerHTML = S.carry === 'no' ? supportHtml() : ''; }));
    const cm = $('#copyMemo', box);
    if (cm) cm.addEventListener('click', async () => { const ok = await copyText($('#memo').textContent); toast(ok ? 'メモをコピーしました' : 'コピーできませんでした。メモを長押しして選択してください', !ok); });
    $$('[data-copy]', box).forEach(b => b.addEventListener('click', async () => { const ok = await copyText(b.dataset.copy); toast(ok ? '電話番号をコピーしました' : 'コピーできませんでした', !ok); }));
    $$('[data-copyname]', box).forEach(a => a.addEventListener('click', () => { copyText(a.dataset.copyname).then(ok => toast(ok ? `「${a.dataset.copyname}」をコピーしました` : 'コピーできませんでした', !ok)); }));
  }

  // ---------- バッテリー単体 ----------
  function renderBattery() {
    $$('input[name=bkind]').forEach(r => r.checked = r.value === S.bkind);
    $('#bDamaged').checked = !!S.bDamaged;
    const B = D.rules.battery, out = $('#batteryResult');
    if (!S.bkind) { out.innerHTML = '<p class="hint">種類を選ぶと出し方を表示します。</p>'; return; }
    let t, title;
    if (S.bkind === 'car') { title = '市では収集できません'; t = B.car; }
    else if (S.bDamaged) { title = '集積場所には出せません'; t = B.damaged; }
    else if (S.bkind === 'small') { title = '家庭ごみの「電池類」で出せます'; t = B.small; }
    else { title = 'このアプリでは確定できません'; t = B.sodaiSizeBattery; }
    out.innerHTML = verdict(S.bkind === 'small' && !S.bDamaged ? 'no' : 'unk', esc(title), `<p>${esc(t)}</p>`)
      + (S.bkind === 'big' ? phoneBlock(true) : '') + (S.bDamaged && S.bkind !== 'car' ? `<a class="btn wide" href="${esc(D.rules.reception.jimushoUrl)}" target="_blank" rel="noopener">区の資源循環局事務所 ↗</a>` : '')
      + src(B.sources);
    $$('[data-copy]', out).forEach(b => b.addEventListener('click', async () => { const ok = await copyText(b.dataset.copy); toast(ok ? '電話番号をコピーしました' : 'コピーできませんでした', !ok); }));
  }

  // ---------- 共通UI ----------
  async function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* 下へ */ }
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } ta.remove(); return ok;
  }
  function toast(msg, ng) { const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (ng ? ' ng' : ''); clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = 'toast'; }, 4000); }

  function bind() {
    $('#homeForm').addEventListener('submit', e => { e.preventDefault(); S.route = 'name'; $('#q').value = $('#homeQ').value; go('item'); });
    $('#toPhoto').addEventListener('click', () => { S.route = 'photo'; go('photo'); });
    $$('[data-gohome]').forEach(b => b.addEventListener('click', () => { go('item'); setTimeout(() => $('#q').focus(), 50); }));
    $$('[data-back]').forEach(b => b.addEventListener('click', back));
    $$('[data-restart]').forEach(b => b.addEventListener('click', restart));
    let t; $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderResults, 120); });
    $('#notInList').addEventListener('click', () => { resetInputs(); S.groupKey = null; S.naKey = null; S.notInList = true; go('size'); });
    $('#sizeForm').addEventListener('input', () => updateSizeUI(false));
    $('#sizeForm').addEventListener('change', () => updateSizeUI(false));
    $('#sizeForm').addEventListener('submit', e => { e.preventDefault(); if (updateSizeUI(true)) go('result'); else $('#sizeError').focus?.(); });
    $('#s-battery').addEventListener('change', () => { S.bkind = ($('input[name=bkind]:checked') || {}).value || null; S.bDamaged = $('#bDamaged').checked; save(); renderBattery(); });
    $('#cameraInput').addEventListener('change', e => { addPhotos(e.target.files); e.target.value = ''; });
    $('#galleryInput').addEventListener('change', e => { addPhotos(e.target.files); e.target.value = ''; });
    $('#keepPhotos').addEventListener('change', e => { S.keepPhotos = e.target.checked; save(); if (S.keepPhotos) storePhotos(); else clearStoredPhotos(); });
    $('#feedbackLink').addEventListener('click', e => { if (e.currentTarget.getAttribute('aria-disabled') === 'true') e.preventDefault(); });
  }

  function restart() {
    D.photos.forEach(p => URL.revokeObjectURL(p.url)); D.photos = [];
    clearStoredPhotos();
    Object.assign(S, { screen: 'home', route: 'name', q: '', groupKey: null, naKey: null, notInList: false, longest: '', dims: { d: '', w: '', h: '' }, grokReply: '', wiz: 1, candidates: null, keepPhotos: false });
    resetInputs();
    ['#homeQ', '#q', '#dimD', '#dimW', '#dimH', '#grokReply'].forEach(id => $(id).value = '');
    $('#keepPhotos').checked = false; $('#aiConsent').checked = false; $('#parsedBox').hidden = true; $('#cands').hidden = true;
    renderThumbs(); setWiz(1); clearSaved();
    history.replaceState({ screen: 'home', idx: 0 }, ''); show('home', true);
  }

  // ---------- 写真（早い段階で縮小・再エンコード＝位置情報などを除去） ----------
  async function decode(file) {
    if (window.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* 下へ */ } }
    return await new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }
  const toBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
  async function reencode(file) {
    const img = await decode(file);
    const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
    const k = Math.min(1, MAX_EDGE / Math.max(w0, h0));
    const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    img.close && img.close();
    const blob = await toBlob(c, 0.85);
    c.width = c.height = 0;
    if (!blob) throw new Error('encode');
    return blob;
  }
  let adding = Promise.resolve();
  function addPhotos(list) {
    const files = [...list];
    adding = adding.then(async () => {
      for (const f of files) {
        if (D.photos.length >= MAX_PHOTOS) { setPhotoStatus(`写真は${MIN_PHOTOS}〜${MAX_PHOTOS}枚です。これ以上は追加できません。`, 'ng'); break; }
        if (!f.type.startsWith('image/')) { setPhotoStatus('画像ファイルを選んでください。', 'ng'); continue; }
        if (f.size > MAX_FILE_MB * 1024 * 1024) { setPhotoStatus(`${MAX_FILE_MB}MBを超える写真は使えません。`, 'ng'); continue; }
        setPhotoStatus('写真を準備中…');
        try {
          const blob = await reencode(f);
          D.photos.push({ blob, url: URL.createObjectURL(blob), id: Math.random().toString(36).slice(2) });
        } catch { setPhotoStatus('この写真は読み込めませんでした。別の写真を選ぶか、カメラで撮り直してください。', 'ng'); continue; }
      }
      renderThumbs(); if (S.keepPhotos) storePhotos();
    });
    return adding;
  }
  function removePhoto(id) {
    const i = D.photos.findIndex(p => p.id === id);
    if (i >= 0) { URL.revokeObjectURL(D.photos[i].url); D.photos.splice(i, 1); }
    renderThumbs(); if (S.keepPhotos) storePhotos();
  }
  function setPhotoStatus(t, cls) { const el = $('#photoStatus'); el.textContent = t; el.className = 'status ' + (cls || ''); }
  function renderThumbs() {
    $('#thumbs').innerHTML = D.photos.map((p, i) => `<div class="thumb"><img src="${p.url}" alt="写真${i + 1}"><span class="no">${'①②③④'[i]}</span><button type="button" class="del" data-id="${p.id}" aria-label="写真${i + 1}を削除">×</button></div>`).join('');
    $$('#thumbs .del').forEach(b => b.addEventListener('click', () => removePhoto(b.dataset.id)));
    const n = D.photos.length, ok = n >= MIN_PHOTOS;
    setPhotoStatus(n === 0 ? `同じ物を${MIN_PHOTOS}枚以上撮ってください（${MAX_PHOTOS}枚まで）。` : ok ? `${n}枚あります（${MAX_PHOTOS}枚まで）。` : `あと${MIN_PHOTOS - n}枚撮ってください（${MIN_PHOTOS}〜${MAX_PHOTOS}枚）。`, n === 0 ? '' : ok ? 'ok' : 'ng');
    updatePrep();
  }

  // IndexedDB（同意した場合のみ・24時間で削除）
  function idb() { return new Promise((res, rej) => { if (!window.indexedDB) return rej(new Error('no idb')); const r = indexedDB.open('yokohama-sodai', 1); r.onupgradeneeded = () => r.result.createObjectStore('photos'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function idbDo(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('photos', mode); const st = tx.objectStore('photos'); const out = fn(st); tx.oncomplete = () => { db.close(); res(out && out.result); }; tx.onerror = () => { db.close(); rej(tx.error); }; }); }
  function storePhotos() { idbDo('readwrite', st => st.put({ savedAt: Date.now(), blobs: D.photos.map(p => p.blob) }, 'current')).catch(() => {}); }
  function clearStoredPhotos() { idbDo('readwrite', st => st.delete('current')).catch(() => {}); }
  async function restorePhotos() {
    try {
      const v = await idbDo('readonly', st => st.get('current'));
      if (!v || Date.now() - v.savedAt > PHOTO_TTL_MS) { clearStoredPhotos(); return; }
      D.photos = v.blobs.map(blob => ({ blob, url: URL.createObjectURL(blob), id: Math.random().toString(36).slice(2) }));
    } catch { /* 復元できない */ }
  }
  async function purgeOldPhotos() { try { const v = await idbDo('readonly', st => st.get('current')); if (v && Date.now() - v.savedAt > PHOTO_TTL_MS) clearStoredPhotos(); } catch { /* */ } }

  // ---------- AI（任意） ----------
  function setupGrok() {
    $('#grokPrompt').value = G.PROMPT;
    const P = D.rules.privacy;
    $('#xaiPolicyText').textContent = P.summary;
    $('#xaiPolicyLink').href = P.xaiPolicyUrl;
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1), android = /Android/.test(ua);
    if (ios) $('#storeAndroid').hidden = true; if (android) $('#storeIos').hidden = true;
    $('#aiConsent').addEventListener('change', updatePrep);
    $$('[data-wgo]').forEach(b => b.addEventListener('click', () => setWiz(+b.dataset.wgo, true)));
    $('#copyPrompt').addEventListener('click', async () => { const ok = await copyText(G.PROMPT); setCopyStatus(ok ? 'コピーしました。AIの入力欄に貼り付けてください。' : 'コピーできませんでした。文章を長押しして選択・コピーしてください。', ok ? 'ok' : 'ng'); });
    $('#sharePhotos').addEventListener('click', shareCombined);
    $('#saveCombined').addEventListener('click', saveCombined);
    $('#pasteReply').addEventListener('click', async () => { try { const t = await navigator.clipboard.readText(); if (t) { $('#grokReply').value = t; parseGrok(); } } catch { setCopyStatus('貼り付けできませんでした。欄を長押しして「ペースト」してください。', 'ng'); $('#grokReply').focus(); } });
    if (!navigator.clipboard?.readText) $('#pasteReply').hidden = true;
    $('#parseReply').addEventListener('click', () => parseGrok());
    setWiz(S.wiz || 1);
  }
  function setWiz(n, focus) {
    S.wiz = n; save();
    $$('.wiz').forEach(w => w.hidden = +w.dataset.w !== n);
    $$('.wiz-ind li').forEach(li => { const k = +li.dataset.w; li.classList.toggle('on', k === n); if (k === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
    if (focus) $(`.wiz[data-w="${n}"] h3`)?.setAttribute('tabindex', '-1'), $(`.wiz[data-w="${n}"] h3`)?.focus();
  }
  function setCopyStatus(t, c) { const el = $('#copyStatus'); el.textContent = t; el.className = 'status ' + (c || ''); }
  const COMBINED_NAME = 'sodai-photos.jpg';
  let combo = { key: '', p: null, url: null };
  async function composeCombined(blobs) {
    const imgs = await Promise.all(blobs.map(decode));
    const H = 900, GAP = 20, PAD = 14;
    const ws = imgs.map(i => Math.round((i.width || i.naturalWidth) * H / (i.height || i.naturalHeight)));
    const c = document.createElement('canvas'); c.width = ws.reduce((a, b) => a + b, 0) + GAP * (imgs.length - 1) + PAD * 2; c.height = H + PAD * 2;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    let px = PAD;
    imgs.forEach((img, i) => { x.drawImage(img, px, PAD, ws[i], H); x.fillStyle = 'rgba(0,0,0,.65)'; x.beginPath(); x.arc(px + 44, PAD + 44, 34, 0, 7); x.fill(); x.fillStyle = '#fff'; x.font = 'bold 44px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('①②'[i], px + 44, PAD + 46); px += ws[i] + GAP; img.close && img.close(); });
    let blob = null; for (const q of [0.85, 0.75, 0.6]) { blob = await toBlob(c, q); if (blob && blob.size < 2e6) break; }
    const out = { file: new File([blob], COMBINED_NAME, { type: 'image/jpeg' }), width: c.width, height: c.height };
    c.width = c.height = 0;
    return out;
  }
  function getCombined() {
    const key = D.photos.slice(0, 2).map(p => p.id).join('|');
    if (key !== combo.key || !combo.p) { combo.key = key; combo.p = composeCombined(D.photos.slice(0, 2).map(p => p.blob)); }
    return combo.p;
  }
  function canShareFiles() { try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/jpeg' })], COMBINED_NAME, { type: 'image/jpeg' })] })); } catch { return false; } }
  function updatePrep() {
    const ok = D.photos.length >= MIN_PHOTOS, consent = $('#aiConsent').checked;
    $('#prepBox').hidden = !consent;
    $('#w1next').disabled = !(consent && ok);
    if (!consent) return;
    $('#sharePhotos').hidden = !(ok && canShareFiles());
    $('#saveCombined').disabled = !ok;
    $('#perPhoto').innerHTML = D.photos.map((p, i) => `<button type="button" class="btn" data-pp="${i}">写真${'①②③④'[i]}の保存画面を開きます</button>`).join('');
    $$('#perPhoto [data-pp]').forEach(b => b.addEventListener('click', () => openSave(new File([D.photos[+b.dataset.pp].blob], `sodai-photo-${+b.dataset.pp + 1}.jpg`, { type: 'image/jpeg' }))));
    const prev = $('#combinedPreview'), info = $('#combinedInfo');
    if (!ok) { prev.hidden = true; info.textContent = `写真が${MIN_PHOTOS}枚以上になると、送る画像を作ります。`; return; }
    info.textContent = '送る画像を作成中…';
    const key = D.photos.slice(0, 2).map(p => p.id).join('|');
    getCombined().then(c => {
      if (key !== combo.key) return;
      if (combo.url) URL.revokeObjectURL(combo.url);
      combo.url = URL.createObjectURL(c.file); prev.src = combo.url; prev.hidden = false;
      info.textContent = `写真①②を横に並べた1枚の画像です（Grokアプリは共有で1枚だけ受け取れるため）。位置情報などは含みません。`;
    }).catch(() => { info.textContent = '画像を作れませんでした。「1枚ずつ送りたい場合」を使ってください。'; });
  }
  async function shareCombined() {
    copyText(G.PROMPT);
    try {
      const c = await getCombined();
      const data = { files: [c.file], text: G.PROMPT };
      if (!navigator.canShare(data)) delete data.text;
      await navigator.share(data);
      setCopyStatus('共有先でGrokを選び、文章も貼り付けて送ってください。', 'ok');
    } catch (e) { if (e.name !== 'AbortError') setCopyStatus('共有できませんでした。「保存画面を開きます」を使ってください。', 'ng'); }
  }
  async function openSave(file) {
    // iPhone等：共有シート（「画像を保存」を選べます）。それ以外：ダウンロード
    if (canShareFiles()) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const url = URL.createObjectURL(file), a = document.createElement('a'); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    setCopyStatus('ダウンロード画面を開きました。保存できたか確認してください。', '');
  }
  async function saveCombined() { try { openSave((await getCombined()).file); } catch { setCopyStatus('画像を作れませんでした。', 'ng'); } }
  const HOW = { exact: '名称が一致', prefix: '名称が近い候補', contains: '名称が近い候補', keyword: '別名が近い候補' };
  function parseGrok(silent) {
    const text = $('#grokReply').value; S.grokReply = text; save();
    const p = G.parseReply(text), box = $('#parsedBox');
    box.hidden = false;
    if (!p.ok) { box.className = 'parsed ng'; box.textContent = '回答を読み取れませんでした。「品目名：」で始まる部分をそのまま貼り付けてください。'; return; }
    const catalog = { groups: D.groups, notAccepted: D.rules.notAccepted };
    const cands = G.matchCandidates(p, catalog), na = G.naHint(p, catalog);
    box.className = 'parsed';
    box.innerHTML = `<p>AIの回答：<b>${esc(p.itemName)}</b>${p.aliases.length ? '（' + esc(p.aliases.join('、')) + '）' : ''}</p>`
      + (na && na.rule ? `<div class="warn">AIは「${esc(na.rule.label)}」の可能性を挙げています。<button type="button" class="btn wide" data-na="${esc(na.rule.key)}">回収できない物として確認する</button></div>` : '')
      + (cands.length ? `<p class="lead">名称が近い候補（タップで選ぶ）</p><div class="results" role="list">${cands.map(c => { const g = D.groups.find(x => x.baseName === c.baseName); return itemBtn(g, `data-g="${esc(c.baseName)}"`).replace('</span>', `<span class="kw">${HOW[c.how]}</span></span>`); }).join('')}</div>` : '<p>品目一覧に近い名前が見つかりませんでした。</p>')
      + '<p class="hint">AIの答えは間違うことがあります。違うと思ったら名前で探してください。</p><button type="button" class="btn wide" data-gohome2>🔍 品目名で調べる</button>';
    $$('[data-g]', box).forEach(b => b.addEventListener('click', () => selectGroup(b.dataset.g)));
    $$('[data-na]', box).forEach(b => b.addEventListener('click', () => selectNA(b.dataset.na)));
    $('[data-gohome2]', box).addEventListener('click', () => { $('#q').value = p.itemName; go('item'); });
    if (!silent) box.focus?.();
  }

  // ---------- Service Worker（更新は確認してから） ----------
  function setupSW() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    $('#reloadBtn').addEventListener('click', () => {
      if (S.screen !== 'home' && !confirm('アプリを更新します。入力内容は残りますが、一時保存していない写真は消えます。更新しますか？')) return;
      save(); location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      reg.addEventListener('updatefound', () => { const nw = reg.installing; if (!nw || !reg.active) return; nw.addEventListener('statechange', () => { if (nw.state === 'activated') $('#updateBar').hidden = false; }); });
      const check = () => reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      setInterval(check, 30 * 60 * 1000);
    }).catch(() => {});
    window.addEventListener('online', renderNotices); window.addEventListener('offline', renderNotices);
  }

  window.__sodai = { S, D, go, show, selectGroup, selectNA, addPhotos, getCombined, renderResult, parseGrok, setWiz, restart, version: APP_VERSION };
  document.addEventListener('DOMContentLoaded', init);
})();
