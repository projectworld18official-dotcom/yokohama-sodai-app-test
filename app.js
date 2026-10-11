'use strict';
(() => {
  const MIN_PHOTOS = 2;
  const MAX_PHOTOS = 10;
  const MAX_DIM_CM = 1000;
  const MAT_LABEL = { metal: '金属・資源物', burnable: '木・プラ等・燃やすもの', nonburnable: '陶磁器・石等・燃えないもの' };

  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = n => n.toLocaleString('ja-JP') + '円';
  const norm = s => (s || '').normalize('NFKC').toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s・･:：()（）]/g, '');

  const state = { photos: [], fees: null, rules: null, groups: [], group: null, material: null, notInList: false, dims: null, method: 'collect', category: null, aiDims: null, aiMaterial: null, grokReply: '' };

  // ---------- 初期化 ----------
  async function init() {
    $('#minPhotosLabel').textContent = MIN_PHOTOS;
    try {
      const [f, r] = await Promise.all([fetch('data/fees.json').then(x => x.json()), fetch('data/rules.json').then(x => x.json())]);
      state.fees = f; state.rules = r;
      $('#dataDate').textContent = f.retrievedAt;
      buildGroups();
      renderCategories(); renderResults(); renderNA();
    } catch (e) {
      $('#recogBox').textContent = 'データの読み込みに失敗しました：' + e.message;
      console.error(e);
    }
    setupGrok();
    bind();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  function buildGroups() {
    const map = new Map();
    for (const it of state.fees.items) {
      if (!map.has(it.baseName)) map.set(it.baseName, { baseName: it.baseName, category: it.category, items: [], keywords: new Set(), notAccepted: it.notAccepted });
      const g = map.get(it.baseName);
      g.items.push(it); it.keywords.forEach(k => g.keywords.add(k));
    }
    state.groups = [...map.values()].map(g => {
      g.keywords = [...g.keywords];
      g.materials = [...new Set(g.items.map(i => i.material).filter(Boolean))];
      const fees = g.items.map(i => i.feeYen).filter(v => v != null);
      g.minFee = Math.min(...fees); g.maxFee = Math.max(...fees);
      g.search = norm([g.baseName, ...g.keywords, ...g.items.map(i => i.name)].join('|'));
      return g;
    }).sort((a, b) => a.baseName.localeCompare(b.baseName, 'ja'));
  }

  // ---------- STEP 制御 ----------
  function go(n) {
    document.querySelectorAll('.step').forEach(s => s.hidden = s.id !== 'step' + n);
    document.querySelectorAll('.stepper li').forEach(li => {
      const k = +li.dataset.step; li.classList.toggle('active', k === n); li.classList.toggle('done', k < n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function bind() {
    $('#cameraInput').addEventListener('change', e => { addPhotos(e.target.files); e.target.value = ''; });
    $('#galleryInput').addEventListener('change', e => { addPhotos(e.target.files); e.target.value = ''; });
    $('#toStep2').addEventListener('click', () => { if (state.photos.length >= MIN_PHOTOS) { go(2); runRecognizer(); } });
    document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => go(+b.dataset.back)));
    $('#searchInput').addEventListener('input', renderResults);
    $('#notInList').addEventListener('click', () => selectGroup(null, true));
    $('#toStep3').addEventListener('click', () => { prepStep3(); go(3); });
    $('#dimForm').addEventListener('submit', e => { e.preventDefault(); if (validateDims(true)) { renderResult(); go(4); } });
    ['#dimD', '#dimW', '#dimH'].forEach(id => $(id).addEventListener('input', () => validateDims(false)));
    $('#restart').addEventListener('click', restart);
  }

  // ---------- 写真 ----------
  function addPhotos(fileList) {
    for (const f of fileList) {
      if (!f.type.startsWith('image/')) continue;
      if (state.photos.length >= MAX_PHOTOS) { setPhotoStatus(`写真は最大${MAX_PHOTOS}枚までです。`, 'ng'); break; }
      state.photos.push({ file: f, url: URL.createObjectURL(f), id: Math.random().toString(36).slice(2) });
    }
    renderThumbs();
  }
  function removePhoto(id) {
    const i = state.photos.findIndex(p => p.id === id);
    if (i >= 0) { URL.revokeObjectURL(state.photos[i].url); state.photos.splice(i, 1); }
    renderThumbs();
  }
  function setPhotoStatus(t, cls) { const el = $('#photoStatus'); el.textContent = t; el.className = 'status ' + (cls || ''); }
  function renderThumbs() {
    const box = $('#thumbs');
    box.innerHTML = state.photos.map((p, i) => `<div class="thumb"><img src="${p.url}" alt="写真${i + 1}"><span class="no">${i + 1}</span><button class="del" data-id="${p.id}" aria-label="写真${i + 1}を削除">×</button></div>`).join('');
    box.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => removePhoto(b.dataset.id)));
    const n = state.photos.length, ok = n >= MIN_PHOTOS;
    $('#toStep2').disabled = !ok;
    $('#grokSection').hidden = !ok;
    updateShare();
    setPhotoStatus(n === 0 ? '' : ok ? `${n}枚の写真があります。次へ進めます。` : `あと${MIN_PHOTOS - n}枚撮影してください（最低${MIN_PHOTOS}枚）。`, ok ? 'ok' : 'ng');
  }

  // ---------- 認識（プラグイン） ----------
  async function runRecognizer() {
    const box = $('#recogBox'), chips = $('#aiCandidates');
    box.textContent = '写真を解析中…'; chips.innerHTML = '';
    try {
      const catalog = { groups: state.groups.map(g => ({ baseName: g.baseName, category: g.category, materials: g.materials, keywords: g.keywords })), notAccepted: state.rules.notAccepted };
      const out = await window.SodaiRecognizer.recognize(state.photos.map(p => p.file), catalog, { grokReply: state.grokReply }) || {};
      state.aiMaterial = out.material || null;
      showNaHint(out.notAcceptedHint);
      if (!out.candidates?.length && out.parsed?.itemName && !$('#searchInput').value) { $('#searchInput').value = out.parsed.itemName; renderResults(); }
      const cands = (out.candidates || []).filter(c => state.groups.some(g => g.baseName === c.baseName)).slice(0, 5);
      state.aiDims = out.estimatedDims || null;
      box.textContent = out.message || (cands.length ? 'Grokの回答から見つけた公式品目の候補です。正しいものをタップして確定してください（AIの推定は間違うことがあります）。' : 'Grokの回答に合う公式品目が見つかりませんでした。検索・一覧から選んでください。');
      chips.innerHTML = cands.map(c => `<button class="chip ai" data-b="${esc(c.baseName)}">${esc(c.baseName)}${c.confidence != null ? ` ${Math.round(c.confidence * 100)}%` : ''}</button>`).join('');
      chips.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        const c = cands.find(x => x.baseName === b.dataset.b);
        selectGroup(state.groups.find(g => g.baseName === b.dataset.b), false, c && c.material);
      }));
    } catch (e) {
      console.error(e); box.textContent = '自動判定でエラーが発生しました。検索から選んでください。';
    }
  }

  // ---------- 品目検索 ----------
  function renderCategories() {
    const cats = [...new Set(state.groups.map(g => g.category).filter(Boolean))];
    $('#categoryChips').innerHTML = ['すべて', ...cats].map(c => `<button class="chip${(c === 'すべて' && !state.category) || c === state.category ? ' on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
    $('#categoryChips').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.category = b.dataset.c === 'すべて' ? null : b.dataset.c; renderCategories(); renderResults(); }));
  }
  function feeText(g) {
    if (g.notAccepted) return '<span class="fee na">受付不可</span>';
    return `<span class="fee">${g.minFee === g.maxFee ? yen(g.minFee) : yen(g.minFee) + '〜' + yen(g.maxFee)}</span>`;
  }
  function renderResults() {
    const q = norm($('#searchInput').value);
    let list = state.groups.filter(g => !g.notAccepted && (!state.category || g.category === state.category));
    if (q) {
      list = state.groups.filter(g => g.search.includes(q));
      list.sort((a, b) => (norm(a.baseName).startsWith(q) ? 0 : 1) - (norm(b.baseName).startsWith(q) ? 0 : 1));
    }
    const ul = $('#results');
    ul.innerHTML = list.slice(0, 80).map(g => `<li data-b="${esc(g.baseName)}"${state.group === g ? ' class="sel"' : ''}><span class="nm">${esc(g.baseName)}<span class="kw">${esc(g.keywords.slice(0, 4).join('、'))}</span></span>${feeText(g)}</li>`).join('')
      + (list.length > 80 ? `<li class="kw">他${list.length - 80}件。キーワードで絞り込んでください。</li>` : '')
      + (list.length === 0 ? '<li>該当なし。「一覧に見つからない」を押してください。</li>' : '');
    ul.querySelectorAll('li[data-b]').forEach(li => li.addEventListener('click', () => selectGroup(state.groups.find(g => g.baseName === li.dataset.b))));
  }
  function renderNA() {
    const ul = $('#naList');
    ul.innerHTML = state.rules.notAccepted.map((n, i) => `<li data-i="${i}"><span class="nm">${esc(n.label)}</span><span class="fee na">受付不可</span></li>`).join('');
    ul.querySelectorAll('li').forEach(li => li.addEventListener('click', () => {
      const n = state.rules.notAccepted[+li.dataset.i];
      state.group = { baseName: n.label, notAccepted: true, items: [], materials: [], naRule: n };
      state.notInList = false; state.material = null;
      afterSelect();
    }));
  }

  function selectGroup(g, notInList = false, suggestedMat = null) {
    state.group = g; state.notInList = notInList; state.material = null;
    if (g && g.materials.length === 1) state.material = g.materials[0];
    suggestedMat = suggestedMat || state.aiMaterial;
    if (g && suggestedMat && g.materials.includes(suggestedMat)) state.material = suggestedMat;
    afterSelect();
  }
  function afterSelect() {
    const g = state.group, box = $('#materialBox'), sel = $('#selectedItem');
    renderResults();
    if (state.notInList) {
      box.hidden = true; sel.hidden = false;
      sel.innerHTML = '品目：<b>一覧にない物</b>（サイズと素材から粗大ごみに当たるかを判定し、電話での申込み方法を案内します）';
    } else if (g) {
      sel.hidden = false;
      sel.innerHTML = `品目：<b>${esc(g.baseName)}</b>${g.notAccepted ? '（市では回収できません）' : ''}`;
      if (!g.notAccepted && g.materials.length > 1) {
        box.hidden = false;
        $('#materialOptions').innerHTML = g.materials.map(m => { const lb = [...new Set(g.items.filter(i => i.material === m).map(i => i.materialLabel).filter(Boolean))].join('・'); return `<label><input type="radio" name="mat" value="${m}"${state.material === m ? ' checked' : ''}> ${esc(lb ? lb + '（' + MAT_LABEL[m] + '）' : MAT_LABEL[m])}</label>`; }).join('');
        $('#materialOptions').querySelectorAll('input').forEach(r => r.addEventListener('change', () => { state.material = r.value; updateNext2(); }));
      } else box.hidden = true;
    }
    updateNext2();
    if (window.innerWidth < 700) sel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function updateNext2() {
    const g = state.group;
    $('#toStep3').disabled = !(state.notInList || (g && (g.notAccepted || g.materials.length <= 1 || state.material)));
  }

  // ---------- サイズ ----------
  function prepStep3() {
    $('#unknownMaterialBox').hidden = !(state.notInList || (state.group && !state.group.notAccepted && state.group.materials.length === 0));
    const ids = [['#dimD', 'd'], ['#dimW', 'w'], ['#dimH', 'h']];
    if (state.aiDims && ids.every(([id]) => !$(id).value)) {
      ids.forEach(([id, k]) => { if (state.aiDims[k] != null) { $(id).value = state.aiDims[k]; $(id).classList.add('prefilled'); } });
      $('#dimConfirmBox').hidden = false; $('#dimConfirm').checked = false;
      $('#dimInfo').textContent = 'Grokの推定値を仮入力しました（黄色の欄）。写真からの推定は誤差が大きいので、実測して修正してください。';
    }
    if (!state.aiMaterial && !$('#unknownMaterialBox').hidden) {} else if (state.aiMaterial) { const r = document.querySelector(`input[name=umat][value=${state.aiMaterial}]`); if (r && !document.querySelector('input[name=umat]:checked')) r.checked = true; }
    validateDims(false);
  }
  function validateDims(strict) {
    const ids = { d: '#dimD', w: '#dimW', h: '#dimH' }, names = { d: '縦', w: '横', h: '高さ' }, vals = {}, errs = [];
    for (const k in ids) {
      const el = $(ids[k]), raw = el.value.trim(), v = Number(raw);
      let bad = false;
      if (raw === '') { if (strict) { errs.push(`${names[k]}を入力してください`); bad = true; } }
      else if (!isFinite(v) || v <= 0) { errs.push(`${names[k]}は0より大きい数値で入力してください`); bad = true; }
      else if (v > MAX_DIM_CM) { errs.push(`${names[k]}が大きすぎます（${MAX_DIM_CM}cm以下）`); bad = true; }
      el.classList.toggle('invalid', bad);
      vals[k] = v;
    }
    if (strict && !$('#unknownMaterialBox').hidden && !document.querySelector('input[name=umat]:checked')) errs.push('主な素材を選んでください');
    if (strict && !$('#dimConfirmBox').hidden && !$('#dimConfirm').checked) errs.push('Grokの推定値を確認したらチェックを入れてください');
    $('#dimError').textContent = errs.join(' / ');
    const all = ['d', 'w', 'h'].every(k => $(ids[k]).value.trim() !== '' && vals[k] > 0 && vals[k] <= MAX_DIM_CM);
    if (all) { state.dims = vals; if ($('#dimConfirmBox').hidden) $('#dimInfo').textContent = `一番長い辺：${Math.max(vals.d, vals.w, vals.h)}cm`; }
    return errs.length === 0 && all;
  }

  // ---------- 判定 ----------
  function sizeOk(it, L) {
    const c = it.sizeCondition; if (!c) return true;
    if (c.longestLtCm != null) return L < c.longestLtCm;
    if (c.longestGteCm != null) return L >= c.longestGteCm;
    return true;
  }
  function determine() {
    const R = state.rules, g = state.group, d = state.dims, L = Math.max(d.d, d.w, d.h);
    if (g && g.notAccepted) {
      const rule = g.naRule || R.notAccepted.find(n => n.match.some(m => g.baseName.includes(m)));
      const item = g.items && g.items[0];
      return { type: 'na', L, rule, item };
    }
    let mat = state.material;
    if (!mat && !$('#unknownMaterialBox').hidden) mat = (document.querySelector('input[name=umat]:checked') || {}).value;
    const metal = mat === 'metal';
    const th = metal ? R.definition.metalThresholdCm : R.definition.nonMetalThresholdCm;
    const isSodai = L >= th;
    let variant = null, variants = [];
    if (g) {
      variants = g.items.filter(i => !mat || !i.material || i.material === mat);
      variant = variants.find(i => sizeOk(i, L)) || null;
    }
    return { type: isSodai ? 'yes' : 'no', L, th, mat, metal, variant, variants };
  }

  function photosStrip() { return `<div class="mini-photos">${state.photos.map((p, i) => `<img src="${p.url}" alt="写真${i + 1}">`).join('')}</div>`; }
  function src(urls) { return `<p class="src">出典：${[].concat(urls).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join('<br>')}</p>`; }
  function dimsLine(L) { const d = state.dims; return `縦${d.d}×横${d.w}×高さ${d.h}cm（一番長い辺 ${L}cm）`; }

  function renderResult() {
    const r = determine(), R = state.rules, rc = R.reception, g = state.group;
    let h = photosStrip();
    if (r.type === 'na') {
      const rule = r.rule;
      h += `<div class="verdict na"><p class="big">✕ 粗大ごみとして出せません</p><p>${esc(g.baseName)} は横浜市では回収できない品目です。</p></div>`;
      if (rule) h += `<h3>処分方法</h3><p>${esc(rule.guidance)}</p><div class="linkbtns"><a class="btn" href="${esc(rule.url)}" target="_blank" rel="noopener">公式ページで詳しく見る</a></div>${src(rule.url)}`;
      else if (r.item) h += `<p>${esc(r.item.note)}</p>${r.item.links.map(u => `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener">詳しく見る</a>`).join('')}`;
      h += `<p class="hint">不明な点は粗大ごみ受付センター（<a href="tel:${rc.phoneLandline.replace(/-/g, '')}">${rc.phoneLandline}</a> / 携帯 <a href="tel:${rc.phoneMobileIp.replace(/-/g, '')}">${rc.phoneMobileIp}</a>）へ。</p>`;
      $('#resultBox').innerHTML = h; return;
    }
    const matTxt = r.mat ? MAT_LABEL[r.mat] : '不明';
    if (r.type === 'no') {
      h += `<div class="verdict no"><p class="big">粗大ごみに該当しない可能性が高いです</p><p>${dimsLine(r.L)}／素材：${esc(matTxt)}<br>横浜市の基準：一番長い辺が<b>${r.metal ? '金属製品で30cm以上' : '金属以外で50cm以上'}</b>が粗大ごみ。</p></div>
        <p>${esc(R.smallItemGuide.text)} 分別区分は公式の分別検索で確認してください。</p>
        <div class="linkbtns"><a class="btn primary" href="${R.smallItemGuide.url}" target="_blank" rel="noopener">ごみの分別を調べる（横浜市）</a></div>
        <p class="hint">※サイズは目安です。品目によって扱いが異なる場合があります。迷ったら粗大ごみ受付センターへ（<a href="tel:0570200530">0570-200-530</a> / 携帯 <a href="tel:0453303953">045-330-3953</a>）。</p>
        ${src([R.definition.source, R.smallItemGuide.url])}`;
      $('#resultBox').innerHTML = h; return;
    }
    // 粗大ごみ
    const v = r.variant;
    h += `<div class="verdict yes"><p class="big">◯ 粗大ごみです</p><p>${dimsLine(r.L)}／素材：${esc(matTxt)}<br>（基準：${r.metal ? '金属製品は一番長い辺30cm以上' : '金属以外は一番長い辺50cm以上'}）</p>`;
    if (v) {
      h += `<p class="fee-big">${yen(v.feeYen)}</p><dl class="kv"><dt>公式品目名</dt><dd>${esc(v.officialName)}</dd>${v.sizeCondition ? `<dt>サイズ区分</dt><dd>${v.sizeCondition.longestLtCm ? '長辺' + v.sizeCondition.longestLtCm + 'cm未満' : '長辺' + v.sizeCondition.longestGteCm + 'cm以上'}（入力サイズで自動選択）</dd>` : ''}<dt>手数料</dt><dd>1点あたり。収集・持込み同額</dd></dl>${v.note ? `<p class="hint">注意：${esc(v.note)}</p>` : ''}`;
    } else if (g && r.variants.length) {
      h += `<p>候補の手数料：${r.variants.map(i => esc(i.officialName) + ' ' + yen(i.feeYen)).join(' / ')}</p>`;
    } else {
      h += `<p><b>手数料は粗大ごみ受付センターへの電話で確認</b>してください（品目一覧にない物はネット申込み不可・電話申込み）。</p>`;
    }
    h += `</div>`;
    h += `<div class="tabs" role="tablist"><button data-m="collect" class="${state.method === 'collect' ? 'on' : ''}">自宅前で収集</button><button data-m="self" class="${state.method === 'self' ? 'on' : ''}">自分で持込み</button></div><div id="procBox"></div>`;
    h += `<p class="hint">※手数料は${state.fees.retrievedAt}時点の公式品目一覧に基づきます。申込み時に表示される金額が正です。</p>${src(state.fees.source.url)}`;
    $('#resultBox').innerHTML = h;
    $('#resultBox').querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { state.method = b.dataset.m; renderResult(); }));
    $('#procBox').innerHTML = state.method === 'collect' ? procCollect(v, !g) : procSelf(v, !g);
  }

  function applyStep(phoneOnly) {
    const rc = state.rules.reception;
    const tel = `<a class="btn" href="tel:${rc.phoneLandline.replace(/-/g, '')}">📞 ${rc.phoneLandline}（固定電話）</a><a class="btn" href="tel:${rc.phoneMobileIp.replace(/-/g, '')}">📱 ${rc.phoneMobileIp}（携帯・IP）</a>`;
    if (phoneOnly) return `<li><b>粗大ごみ受付センターに電話で申し込む</b>品目一覧にない物は電話で申込み。${esc(rc.phoneHours)}。<div class="linkbtns">${tel}</div></li>`;
    return `<li><b>粗大ごみ受付センターに申し込む</b>インターネット・チャット・LINEは24時間受付。電話は${esc(rc.phoneHours)}。
      <div class="linkbtns"><a class="btn primary" href="${rc.internetUrl}" target="_blank" rel="noopener">インターネット受付</a><a class="btn" href="${rc.chatUrl}" target="_blank" rel="noopener">チャット受付</a><a class="btn" href="${rc.lineInfoUrl}" target="_blank" rel="noopener">LINE受付について</a>${tel}</div>
      <span class="hint">申込み時に「受付番号（6桁）」と収集日（搬入日）を控えてください。</span></li>`;
  }
  function procCollect(v, phoneOnly) {
    const R = state.rules, c = R.collection, p = R.payment;
    return `<ol class="steps">
      ${applyStep(phoneOnly)}
      <li><b>締切・目安</b>収集日の7日前までに申込み（例：火曜収集なら前週の月曜まで）。受付から収集まで2週間程度。1回の申込みは${c.maxItems}個まで。</li>
      <li><b>手数料を払う（どちらか）</b>
        ①<b>粗大ごみ収集シール</b>を市内の指定金融機関・郵便局・コンビニ（${p.convenienceStores.join('、')}）で${v ? yen(v.feeYen) + '分' : '手数料分'}購入。領収書は収集が終わるまで保管（領収日付印のないものは無効、シールの再発行不可）。<br>
        ②<b>電子決済</b>（ネット・チャット・LINE申込みのみ）：クレジットカード／PayPay。本受付完了メールの決済URLから収集日の3営業日前までに。電話申込みでは不可。</li>
      <li><b>当日の出し方</b>シールの場合：受付番号6桁・収集日・氏名を記入し、見やすい所に貼る。電子決済の場合：10cm四方以上の紙に受付番号6桁と収集日を大きく書き、テープで4辺を貼る。<b>収集日当日の朝8時まで</b>に申込み時に確認した場所へ。雨でも収集（油性ペンで記入）。</li>
      <li><b>注意</b>ストーブ・ガステーブルは灯油や電池を抜く。箱や袋から出し、一式がわかるようにまとめる。申込みなしで出すと不法投棄になります。</li>
    </ol>${src([...c.sources, ...p.sources])}`;
  }
  function procSelf(v, phoneOnly) {
    const S = state.rules.selfDelivery, p = state.rules.payment;
    return `<ol class="steps">
      ${applyStep(phoneOnly)}
      <li><b>締切</b>インターネット受付は搬入日当日15時まで。1日20個まで（栄ストックヤードの簡易申込みは10個まで）。</li>
      <li><b>手数料を払う</b>収集と同じ手数料${v ? '（' + yen(v.feeYen) + '）' : ''}。粗大ごみ収集シールを指定金融機関・郵便局・コンビニで事前購入（ヤードではシール販売なし）。</li>
      <li><b>持ち込む</b>シールを貼り、申し込んだ日時・施設へ。9時前は入場不可。原則本人が持込み（代理は委任状）、荷下ろしは自分で。免許証・車検証の確認がある場合あり。
        <ul>${S.yards.map(y => `<li>${esc(y.name)}：${esc(y.address)}（${esc(y.hours)}／休：${esc(y.closed)}）<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(y.address)}" target="_blank" rel="noopener">地図</a></li>`).join('')}</ul></li>
    </ol>${src(S.sources)}`;
  }

  // ---------- Grokガイド ----------
  const G = () => window.SodaiGrokGuide;
  function setupGrok() {
    if (!G()) return;
    $('#grokPrompt').value = G().PROMPT;
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const android = /Android/.test(ua);
    const rec = ios ? '#storeIos' : android ? '#storeAndroid' : '#storeWeb';
    $(rec).classList.add('rec');
    if (ios || android) { const other = ios ? '#storeAndroid' : '#storeIos'; $(other).hidden = true; }
    $('#copyPrompt').addEventListener('click', copyPrompt);
    $('#sharePhotos').addEventListener('click', sharePhotos);
    $('#pasteReply').addEventListener('click', async () => {
      try { const t = await navigator.clipboard.readText(); if (t) { $('#grokReply').value = t; parseGrok(); } }
      catch { setCopyStatus('貼り付けできませんでした。欄を長押しして「ペースト」してください。', 'ng'); $('#grokReply').focus(); }
    });
    $('#parseReply').addEventListener('click', parseGrok);
    if (!navigator.clipboard?.readText) $('#pasteReply').hidden = true;
  }
  function setCopyStatus(t, c) { const el = $('#copyStatus'); el.textContent = t; el.className = 'status ' + (c || ''); }
  async function copyPrompt() {
    const text = G().PROMPT;
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch { ok = false; }
    if (!ok) {
      const ta = $('#grokPrompt'); ta.removeAttribute('readonly'); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.setAttribute('readonly', ''); window.getSelection()?.removeAllRanges();
    }
    setCopyStatus(ok ? 'コピーしました。Grokの入力欄に貼り付けてください。' : 'コピーできませんでした。文章を長押しして選択・コピーしてください。', ok ? 'ok' : 'ng');
  }
  function shareFiles() { return state.photos.slice(0, 2).map(p => p.file); }
  function updateShare() {
    let can = false;
    try { can = !!(navigator.canShare && state.photos.length >= MIN_PHOTOS && navigator.canShare({ files: shareFiles() })); } catch { can = false; }
    $('#shareRow').hidden = !can;
  }
  async function sharePhotos() {
    try {
      await copyPrompt();
      await navigator.share({ files: shareFiles(), text: G().PROMPT });
      setCopyStatus('共有先でGrokを選び、文章も一緒に送ってください（文章はコピー済み）。', 'ok');
    } catch (e) { if (e.name !== 'AbortError') setCopyStatus('共有できませんでした。写真をGrokで直接添付してください。', 'ng'); }
  }
  function parseGrok() {
    const text = $('#grokReply').value;
    state.grokReply = text;
    const p = G().parseReply(text), box = $('#parsedBox');
    box.hidden = false;
    if (!p.ok) { box.className = 'parsed ng'; box.textContent = '回答を読み取れませんでした。Grokの回答（「品目名：」で始まる部分）をそのままコピーして貼り付けてください。'; return; }
    box.className = 'parsed';
    const d = p.dims, dim = k => d[k] != null ? d[k] + 'cm' : '—';
    state.aiDims = (d.d || d.w || d.h) ? { d: d.d ?? null, w: d.w ?? null, h: d.h ?? null } : null;
    state.aiMaterial = p.material;
    box.innerHTML = `<b>読み取り結果（Grokの推定・未確定）</b><dl>
      <dt>品目名</dt><dd>${esc(p.itemName || '—')}${p.aliases.length ? '（' + esc(p.aliases.join('、')) + '）' : ''}</dd>
      <dt>主な素材</dt><dd>${esc(p.materialRaw || '—')}${p.material ? ' → ' + MAT_LABEL[p.material] : ''}</dd>
      <dt>サイズ</dt><dd>縦${dim('d')}×横${dim('w')}×高さ${dim('h')}</dd>
      <dt>回収対象外</dt><dd>${esc(p.notAcceptedRaw || '—')}</dd>
      <dt>確信度</dt><dd>${esc(p.confidence || '—')}</dd></dl>
      <span class="hint">「次へ」で公式品目の候補を表示します。品目と寸法は次の画面で確認・修正できます。</span>`;
    ['#dimD', '#dimW', '#dimH'].forEach(id => { $(id).value = ''; $(id).classList.remove('prefilled'); });
    if (p.itemName) $('#searchInput').value = '';
  }
  function showNaHint(h) {
    $('#naHint')?.remove();
    if (!h || !h.flagged) return;
    const div = document.createElement('div'); div.id = 'naHint'; div.className = 'na-warn';
    div.innerHTML = h.rule
      ? `⚠ Grokは「${esc(h.rule.label)}」の可能性を挙げています。該当する場合、横浜市では粗大ごみとして出せません。<button type="button" class="btn" style="margin-top:6px;width:100%">回収できない物として確認する</button>`
      : `⚠ Grokは回収対象外の可能性（${esc(h.raw)}）を挙げています。下の「市で回収できない物」も確認してください。`;
    $('#recogBox').after(div);
    const b = div.querySelector('button');
    if (b) b.addEventListener('click', () => { state.group = { baseName: h.rule.label, notAccepted: true, items: [], materials: [], naRule: h.rule }; state.notInList = false; state.material = null; afterSelect(); });
  }

  function restart() {
    state.photos.forEach(p => URL.revokeObjectURL(p.url));
    Object.assign(state, { photos: [], group: null, material: null, notInList: false, dims: null, method: 'collect', aiDims: null, aiMaterial: null, grokReply: '' });
    $('#grokReply').value = ''; $('#parsedBox').hidden = true; $('#dimConfirmBox').hidden = true; $('#naHint')?.remove();
    ['#dimD', '#dimW', '#dimH'].forEach(id => $(id).classList.remove('prefilled'));
    ['#dimD', '#dimW', '#dimH', '#searchInput'].forEach(id => $(id).value = '');
    document.querySelectorAll('input[name=umat]').forEach(r => r.checked = false);
    $('#selectedItem').hidden = true; $('#materialBox').hidden = true; $('#dimInfo').textContent = ''; $('#dimError').textContent = '';
    renderThumbs(); renderResults(); go(1);
  }

  // テスト用に公開
  window.__sodai = { state, determine, addPhotos, selectGroup, go, validateDims, renderResult };
  document.addEventListener('DOMContentLoaded', init);
})();
