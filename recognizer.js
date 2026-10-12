/**
 * 品目特定フック（差し替え可能）
 * --------------------------------------------------------------
 * 既定：「Grokガイド方式」— 有料APIは使いません。ユーザー自身が無料のGrok
 * （https://grok.com / Grokアプリ / X内のGrok）に写真と定型プロンプトを送り、
 * 返ってきた定型の回答をこのアプリに貼り付けます。recognize() はその回答を解析して
 * 公式品目一覧（data/fees.json）の候補・素材・寸法を返すだけです。
 * 最終的な判定・手数料は常に横浜市の公式データで計算し、ユーザーが品目と寸法を確認・確定します。
 *
 * app.js からの呼び出し:
 *   window.SodaiRecognizer.recognize(files, catalog, { grokReply })
 *     files     : File[]（2枚以上の写真。Grokガイド方式では未使用）
 *     catalog   : { groups:[{ baseName, category, materials, keywords }], notAccepted:[rules.notAccepted...] }
 *     grokReply : 貼り付けられたGrokの回答テキスト（未入力なら空）
 *   戻り値: { candidates:[{baseName, confidence, material}], material, estimatedDims:{d,w,h}, notAcceptedHint, parsed, message }
 *
 * 将来、自動認識（任意のVision API等）に切り替える場合は、同じ戻り値の形で recognize() を
 * 実装した window.SodaiRecognizer を、このファイルより後に読み込むスクリプトで上書きしてください。
 * （その場合もAPIキーはブラウザに置かず、サーバー側で扱ってください。）
 */
(function () {
  const PROMPT = [
    '添付した画像には、同じ物を2方向から撮影した写真が左右に並んでいます（①左・②右）。写っている物を1つ特定してください。横浜市で粗大ごみとして出せるか調べるために使います。',
    '説明文は不要です。次の形式どおり、各項目1行で答えてください。',
    '',
    '品目名：（一般的な日本語の名称。横浜市の粗大ごみ品目一覧のような言い方で。例：たんす、ソファ、自転車、食器棚、テーブル、カラーボックス、電子レンジ）',
    '別名候補：（他に考えられる名称を最大3つ、「、」区切り）',
    '主な素材：（金属／木／プラスチック／その他 のどれか1つ。その他の場合は括弧で具体的に。例：その他（ガラス））',
    '縦：（写真から推定したおおよその数字）cm',
    '横：（同上）cm',
    '高さ：（同上）cm',
    '回収対象外の可能性：（なし／家電リサイクル法対象（エアコン・テレビ・冷蔵庫・冷凍庫・洗濯機・衣類乾燥機）／パソコン／バイク／消火器／その他（具体的に） のどれか）',
    '確信度：（高／中／低）'
  ].join('\n');

  const nfkc = s => (s || '').normalize('NFKC');
  const norm = s => nfkc(s).toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・･:：()（）「」『』\[\]【】*_`]/g, '');
  const num = s => { const r = nfkc(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:cm)?\s*[〜~～\-－]\s*(\d+(?:\.\d+)?)/); if (r) s = String(Math.max(+r[1], +r[2])) + (/(\d)\s*m(?!m)/.test(nfkc(s)) && !/cm/.test(nfkc(s)) ? 'm' : 'cm'); const m = nfkc(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(m|cm|mm|センチ|メートル)?/i); if (!m) return null; let v = parseFloat(m[1]); const u = (m[2] || 'cm').toLowerCase(); if (u === 'm' || u === 'メートル') v *= 100; if (u === 'mm') v /= 10; return Math.round(v * 10) / 10; };

  const KEYS = {
    item: /^(品目名|品目|品名|名称)$/,
    alias: /^(別名候補|別名|候補|その他の候補)$/,
    material: /^(主な素材|素材|主素材|材質)$/,
    d: /^(縦|奥行き?|奥行)$/,
    w: /^(横|幅)$/,
    h: /^(高さ|高)$/,
    size: /^(サイズ|寸法|大きさ)$/,
    na: /^(回収対象外の可能性|回収対象外|対象外の可能性|注意)$/,
    conf: /^(確信度|信頼度|自信)$/
  };

  /** Grokの回答（定型フォーマット、多少の崩れに対応）を解析 */
  function parseReply(text) {
    const out = { itemName: null, aliases: [], materialRaw: null, material: null, dims: {}, notAcceptedRaw: null, confidence: null, ok: false };
    if (!text || !text.trim()) return out;
    for (let line of nfkc(text).split(/\r?\n/)) {
      line = line.replace(/^[\s>*\-•・#\d.)]+/, '').replace(/\*\*/g, '').trim();
      const m = line.match(/^([^:：]{1,14})[:：]\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim(), val = m[2].trim();
      if (KEYS.item.test(key)) { out.itemNameFull = val.replace(/[「」『』]/g, '').trim(); out.itemName = out.itemNameFull.split(/[（(]/)[0].trim(); }
      else if (KEYS.alias.test(key)) out.aliases = val.split(/[、,，/／]/).map(s => s.replace(/[「」『』]/g, '').trim()).filter(s => s && s !== 'なし').slice(0, 5);
      else if (KEYS.material.test(key)) out.materialRaw = val;
      else if (KEYS.d.test(key)) out.dims.d = num(val);
      else if (KEYS.w.test(key)) out.dims.w = num(val);
      else if (KEYS.h.test(key)) out.dims.h = num(val);
      else if (KEYS.size.test(key)) {
        const t = val.match(/(\d+(?:\.\d+)?)\D{0,6}?[x×*]\D{0,6}?(\d+(?:\.\d+)?)\D{0,6}?[x×*]\D{0,6}?(\d+(?:\.\d+)?)/i);
        if (t) { out.dims.d ??= +t[1]; out.dims.w ??= +t[2]; out.dims.h ??= +t[3]; }
      }
      else if (KEYS.na.test(key)) out.notAcceptedRaw = val;
      else if (KEYS.conf.test(key)) out.confidence = val.replace(/[。.]$/, '');
    }
    const mr = out.materialRaw || '';
    if (/金属|鉄|スチール|アルミ|ステンレス|メタル/.test(mr)) out.material = 'metal';
    else if (/ガラス|陶|磁器|石|大理石|セラミック/.test(mr)) out.material = 'nonburnable';
    else if (/木|プラ|樹脂|布|革|レザー|籐|紙|ゴム|ウレタン|ファブリック/.test(mr)) out.material = 'burnable';
    out.ok = !!(out.itemName || out.dims.d || out.dims.w || out.dims.h);
    return out;
  }

  /** 解析結果を公式品目グループにマッチング */
  function matchCandidates(parsed, catalog) {
    const names = [parsed.itemName, ...parsed.aliases].filter(Boolean);
    const scores = new Map();
    names.forEach((nm, idx) => {
      const q = norm(nm); if (!q) return;
      const w = idx === 0 ? 1 : 0.7;
      for (const g of catalog.groups) {
        const b = norm(g.baseName);
        let s = 0;
        if (b === q) s = 1;
        else if (b.startsWith(q) || q.startsWith(b)) s = 0.85;
        else if (b.includes(q) || (b.length >= 2 && q.includes(b))) s = 0.7;
        else if (g.keywords.some(k => { const kk = norm(k); return kk === q || (kk.length >= 2 && (kk.includes(q) || q.includes(kk))); })) s = 0.6;
        if (s) { s *= w; if (parsed.material && g.materials.includes(parsed.material)) s += 0.05;
          const qual = nfkc(parsed.itemNameFull || ''); const gq = (g.baseName.match(/\(([^)]*)\)/) || [])[1] || '';
          if (gq && qual) { const qn = (qual.match(/(\d+)\s*人/) || [])[1], gn = (gq.match(/(\d+)\s*人/) || [])[1]; if (qn && gn && ((+qn >= 2 && /以上/.test(gq)) || qn === gn)) s += 0.04; else if (norm(qual).includes(norm(gq))) s += 0.04; } if (s > (scores.get(g.baseName) || 0)) scores.set(g.baseName, s); }
      }
    });
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([baseName, c]) => ({ baseName, confidence: Math.min(1, c), material: parsed.material }));
  }

  function naHint(parsed, catalog) {
    const raw = (parsed.notAcceptedRaw || '').trim();
    const flagged = !!raw && !/^(なし|無し|ない|該当なし|特になし|no|none)/i.test(raw);
    const rules = catalog.notAccepted || [];
    if (flagged) {
      const r = rules.find(r => r.match.some(m => raw.includes(m))) || (/家電リサイクル/.test(raw) && rules.find(r => r.key === 'kaden4'))
        || rules.find(r => r.match.some(m => [parsed.itemName, ...parsed.aliases].some(n => n && n.includes(m))));
      return { rule: r || null, flagged: true, raw };
    }
    // 回答が「なし」でも、品目名そのものが回収不可品目なら注意を出す（例：品目名＝冷蔵庫）
    const nm = (parsed.itemName || '').trim();
    const r = rules.find(r => r.match.includes(nm));
    return r ? { rule: r, flagged: true, raw: '' } : null;
  }

  window.SodaiGrokGuide = { PROMPT, parseReply, matchCandidates, naHint, url: 'https://grok.com' };

  window.SodaiRecognizer = window.SodaiRecognizer || {
    mode: 'grok-guide',
    async recognize(files, catalog, ctx = {}) {
      const parsed = parseReply(ctx.grokReply || '');
      if (!parsed.ok) return { candidates: [], parsed, message: 'Grokの回答が未入力です。写真ステップの「Grokで写真を調べる」を使うか、下の検索から品目を選んでください。' };
      const d = parsed.dims, hasDims = d.d && d.w && d.h;
      return {
        candidates: matchCandidates(parsed, catalog),
        material: parsed.material,
        estimatedDims: (d.d || d.w || d.h) ? { d: d.d ?? null, w: d.w ?? null, h: d.h ?? null, complete: !!hasDims } : null,
        notAcceptedHint: naHint(parsed, catalog),
        parsed,
        message: null
      };
    }
  };
})();
