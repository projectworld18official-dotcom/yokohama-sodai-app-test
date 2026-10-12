/**
 * 品目名候補フック（差し替え可能）— 有料APIは使いません。
 * ユーザーが任意で無料のAI（Grok等）に写真を見せ、返ってきた「品目名の候補」だけを貼り付けます。
 * AIには寸法・素材・手数料は聞きません（推定誤差が大きく、判定は公式データと実測値で行うため）。
 *
 *   window.SodaiRecognizer.recognize(files, catalog, { grokReply })
 *     → { candidates:[{ baseName, how }], notAcceptedHint, parsed }
 *   how: 'exact' | 'prefix' | 'contains' | 'keyword'（%などの確信度は出しません）
 *
 * ユーティリティ（テスト対象）:
 *   parseLengthCm('1.2m') → 120 / parseLengthCm('500mm') → 50 / parseLengthCm('5mm') → 0.5
 *   classifyMaterial('非金属') → 'nonmetal'
 */
(function () {
  const PROMPT = [
    '添付画像には、同じ物を2方向から撮った写真が左右に並んでいます（①左・②右）。写っている物の名前を教えてください。横浜市の粗大ごみ品目一覧で探すために使います。',
    '大きさ・素材・料金の推測は不要です。説明文も不要です。次の形式どおり、各項目1行で答えてください。',
    '',
    '品目名：（一般的な日本語の名称。例：たんす、ソファー、自転車、食器棚、テーブル、カラーボックス、電子レンジ）',
    '別名候補：（ほかに考えられる名称を最大3つ、「、」区切り）',
    '回収対象外の可能性：（なし／家電リサイクル法対象（エアコン・テレビ・冷蔵庫・冷凍庫・洗濯機・衣類乾燥機）／パソコン／バイク／消火器／バッテリー／その他（具体的に） のどれか）'
  ].join('\n');

  const nfkc = s => (s || '').normalize('NFKC');
  const hira = s => s.replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const norm = s => hira(nfkc(s).toLowerCase()).replace(/[\s・･:：()（）「」『』\[\]【】*_`、。,.\/／&＆-]/g, '');

  /** 長さの文字列を cm に。単位なしは cm。mm/cm/m/センチ/メートル/ミリ に対応。解釈できなければ null */
  function parseLengthCm(s) {
    const t = nfkc(String(s ?? '')).replace(/,/g, '').trim().toLowerCase();
    const m = t.match(/^(\d+(?:\.\d+)?)\s*(mm|ミリ(?:メートル)?|cm|センチ(?:メートル)?|m|メートル)?$/);
    if (!m) return null;
    let v = parseFloat(m[1]);
    const u = m[2] || 'cm';
    if (u === 'mm' || u.startsWith('ミリ')) v /= 10;
    else if (u === 'm' || u === 'メートル') v *= 100;
    return Math.round(v * 10) / 10;
  }
  /** 「1.2m×0.5m×0.6m」「120×50×60cm」→ [120,50,60]（末尾の単位は全体に適用） */
  function parseDims(s) {
    const t = nfkc(String(s || '')).replace(/,/g, '').toLowerCase();
    const parts = t.split(/\s*[x×*✕]\s*/);
    if (parts.length !== 3) return null;
    const tail = (parts[2].match(/(mm|cm|m)$/) || [])[1] || 'cm';
    const vals = parts.map(p => parseLengthCm(/(mm|cm|m)$/.test(p) ? p : p + tail));
    return vals.every(v => v != null) ? vals : null;
  }
  /** 素材の記述 → 'metal' | 'nonmetal' | null。否定（非金属・金属以外・金属でない）を先に判定 */
  function classifyMaterial(s) {
    const t = nfkc(s || '');
    if (/非金属|金属以外|金属(では|じゃ)?(ない|なし|無し)|金属を?含まない|ノンメタル/.test(t)) return 'nonmetal';
    if (/金属|鉄|スチール|アルミ|ステンレス|メタル|真鍮|銅/.test(t)) return 'metal';
    if (/木|プラ|樹脂|布|革|レザー|籐|紙|ゴム|ウレタン|ガラス|陶|磁器|石|セラミック/.test(t)) return 'nonmetal';
    return null;
  }

  const KEYS = {
    item: /^(品目名|品目|品名|名称)$/,
    alias: /^(別名候補|別名|候補|その他の候補)$/,
    na: /^(回収対象外の可能性|回収対象外|対象外の可能性)$/
  };
  function parseReply(text) {
    const out = { itemName: null, itemNameFull: null, aliases: [], notAcceptedRaw: null, ok: false };
    if (!text || !text.trim()) return out;
    for (let line of nfkc(text).split(/\r?\n/)) {
      line = line.replace(/^[\s>*\-•・#\d.)]+/, '').replace(/\*\*/g, '').trim();
      const m = line.match(/^([^:：]{1,14})[:：]\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim(), val = m[2].trim();
      if (KEYS.item.test(key)) { out.itemNameFull = val.replace(/[「」『』]/g, '').trim(); out.itemName = out.itemNameFull.split(/[（(]/)[0].trim() || null; }
      else if (KEYS.alias.test(key)) out.aliases = val.split(/[、,，/／]/).map(s => s.replace(/[「」『』]/g, '').trim()).filter(s => s && !/^(なし|無し)$/.test(s)).slice(0, 5);
      else if (KEYS.na.test(key)) out.notAcceptedRaw = val;
    }
    out.ok = !!out.itemName;
    return out;
  }

  const RANK = { exact: 0, prefix: 1, contains: 2, keyword: 3 };
  function matchCandidates(parsed, catalog) {
    const names = [parsed.itemName, ...parsed.aliases].filter(Boolean);
    const best = new Map();
    names.forEach((nm, idx) => {
      const q = norm(nm); if (!q) return;
      for (const g of catalog.groups) {
        const b = norm(g.baseName.replace(/\(.*?\)/g, '')) || norm(g.baseName);
        let how = null;
        if (b === q || norm(g.baseName) === q) how = 'exact';
        else if (b.startsWith(q) || q.startsWith(b)) how = 'prefix';
        else if (b.includes(q) || (b.length >= 2 && q.includes(b))) how = 'contains';
        else if (g.keywords.some(k => { const kk = norm(k); return kk === q || (kk.length >= 2 && (kk.includes(q) || q.includes(kk))); })) how = 'keyword';
        if (!how) continue;
        const score = RANK[how] * 10 + idx;
        const prev = best.get(g.baseName);
        if (!prev || score < prev.score) best.set(g.baseName, { baseName: g.baseName, how, score });
      }
    });
    return [...best.values()].sort((a, b) => a.score - b.score || a.baseName.length - b.baseName.length).slice(0, 6).map(({ baseName, how }) => ({ baseName, how }));
  }

  function naHint(parsed, catalog) {
    const raw = (parsed.notAcceptedRaw || '').trim();
    const flagged = !!raw && !/^(なし|無し|ない|該当なし|特になし|no|none)/i.test(raw);
    const rules = catalog.notAccepted || [];
    const names = [parsed.itemName, ...parsed.aliases].filter(Boolean);
    if (flagged) {
      const r = rules.find(r => r.match.some(m => raw.includes(m))) || (/家電リサイクル/.test(raw) && rules.find(r => r.key === 'kaden4'))
        || rules.find(r => r.match.some(m => names.some(n => n.includes(m))));
      return { rule: r || null, flagged: true, raw };
    }
    const r = rules.find(r => r.match.includes((parsed.itemName || '').trim()));
    return r ? { rule: r, flagged: true, raw: '' } : null;
  }

  window.SodaiGrokGuide = { PROMPT, parseReply, matchCandidates, naHint, parseLengthCm, parseDims, classifyMaterial, norm, url: 'https://grok.com' };
  window.SodaiRecognizer = window.SodaiRecognizer || {
    mode: 'grok-guide',
    async recognize(files, catalog, ctx = {}) {
      const parsed = parseReply(ctx.grokReply || '');
      if (!parsed.ok) return { candidates: [], parsed, notAcceptedHint: null };
      return { candidates: matchCandidates(parsed, catalog), notAcceptedHint: naHint(parsed, catalog), parsed };
    }
  };
})();
