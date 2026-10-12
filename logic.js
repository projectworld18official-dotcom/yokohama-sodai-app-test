/* 判定・手数料・検索の純粋ロジック（DOM非依存。ブラウザでは window.SodaiLogic、Node では require で利用） */
(function (root) {
  'use strict';
  const nfkc = s => String(s ?? '').normalize('NFKC');
  const hira = s => s.replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const norm = s => hira(nfkc(s).toLowerCase()).replace(/[\s・･:：()（）「」『』\[\]【】*_`、。,.\/／&＆-]/g, '');
  const yen = n => Number(n).toLocaleString('ja-JP') + '円';

  // 言い換え（よくある表記ゆれ → 公式品目一覧で使われている語）
  const SYNONYMS = [
    ['べっと', 'べっど'], ['石油すとーぶ', 'すとーぶ'], ['灯油すとーぶ', 'すとーぶ'], ['ふぁんひーたー', 'すとーぶ'],
    ['電気かーぺっと', 'かーぺっと'], ['ほっとかーぺっと', 'かーぺっと'], ['じゅうたん', 'かーぺっと'], ['絨毯', 'かーぺっと'], ['らぐ', 'かーぺっと'],
    ['羽毛布団', '布団'], ['掛け布団', '布団'], ['敷き布団', '布団'], ['かけぶとん', '布団'], ['しきぶとん', '布団'], ['ふとん', '布団'], ['ぶとん', '布団'],
    ['乳母車', 'べびーかー'], ['ばぎー', 'べびーかー'],
    ['そふぁ', 'そふぁー'], ['本棚', '書棚'], ['椅子', 'いす'], ['いす', 'いす'], ['箪笥', 'たんす'], ['タンス', 'たんす'],
    ['ちゃりんこ', '自転車'], ['ちゃり', '自転車'], ['ままちゃり', '自転車'], ['こたつ布団', '布団'],
    ['電子れんじ', '電子れんじ'], ['れんじ', '電子れんじ'], ['くっしょんそふぁ', 'そふぁー'], ['まっとれす', 'まっとれす'],
  ].map(([a, b]) => [norm(a), norm(b)]);
  function expandQuery(q) {
    const n = norm(q); if (!n) return [];
    const out = new Set([n]);
    for (const [a, b] of SYNONYMS) if (n.includes(a)) out.add(n.replace(a, b));
    return [...out];
  }

  function buildGroups(fees) {
    const map = new Map();
    for (const it of fees.items) {
      if (!map.has(it.baseName)) map.set(it.baseName, { baseName: it.baseName, category: it.category, items: [], keywords: new Set(), notAccepted: it.notAccepted });
      const g = map.get(it.baseName);
      g.items.push(it); (it.keywords || []).forEach(k => g.keywords.add(k));
    }
    return [...map.values()].map(g => {
      g.keywords = [...g.keywords];
      g.materials = [...new Set(g.items.map(i => i.material).filter(Boolean))];
      const fs = g.items.map(i => i.feeYen).filter(v => v != null);
      g.minFee = fs.length ? Math.min(...fs) : null; g.maxFee = fs.length ? Math.max(...fs) : null;
      g.batteryNote = g.items.some(i => i.batteryNote);
      g.nBase = norm(g.baseName); g.nCore = norm(g.baseName.replace(/\(.*?\)/g, '')) || g.nBase;
      g.search = norm([g.baseName, ...g.keywords, ...g.items.map(i => i.name)].join('|'));
      return g;
    }).sort((a, b) => a.baseName.localeCompare(b.baseName, 'ja'));
  }

  /** 検索：部分一致＋逆包含（「木製の本棚」→「書棚」）＋言い換え。受付不可品目も返す */
  function search(groups, q) {
    const qs = expandQuery(q); if (!qs.length) return [];
    const scored = [];
    for (const g of groups) {
      let s = 99;
      for (const x of qs) {
        if (g.nCore === x || g.nBase === x) s = Math.min(s, 0);
        else if (g.nCore.startsWith(x)) s = Math.min(s, 1);
        else if (g.nBase.includes(x)) s = Math.min(s, 2);
        else if (g.search.includes(x)) s = Math.min(s, 3);
        else if (g.nCore.length >= 2 && x.includes(g.nCore)) s = Math.min(s, 4);
      }
      if (s < 99) scored.push([s, g]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].baseName.length - b[1].baseName.length).map(x => x[1]);
  }

  /** 手数料の計算（結果画面・申し込みメモ・シール案内で共通に使う唯一の計算） */
  function computeFee(variant, count) {
    if (!variant || variant.feeYen == null) return null;
    const n = Math.max(1, Math.floor(Number(count) || 1));
    const b = variant.bundle;
    if (b && b.size > 1) {
      const sets = Math.ceil(n / b.size);
      return { unitYen: variant.feeYen, count: n, unit: b.unit, bundleSize: b.size, sets, totalYen: sets * variant.feeYen,
        unitLabel: `1組（${b.size}${b.unit}まで）あたり`, countLabel: `${n}${b.unit}`, setsLabel: `${sets}組`,
        formula: `${yen(variant.feeYen)} × ${sets}組（${n}${b.unit}を${b.size}${b.unit}ずつ）＝ ${yen(sets * variant.feeYen)}`, condition: b.condition || null };
    }
    return { unitYen: variant.feeYen, count: n, unit: '点', bundleSize: 1, sets: n, totalYen: n * variant.feeYen,
      unitLabel: '1点あたり', countLabel: `${n}点`, setsLabel: `${n}点`, formula: `${yen(variant.feeYen)} × ${n}点 ＝ ${yen(n * variant.feeYen)}`, condition: null };
  }

  function sizeOk(it, L) {
    const c = it.sizeCondition; if (!c) return true;
    if (c.longestLtCm != null) return L < c.longestLtCm;
    if (c.longestGteCm != null) return L >= c.longestGteCm;
    return true;
  }
  const isMetal = m => m === 'metal';

  /**
   * どの材質区分で判定するか（しきい値 30cm / 50cm）
   *  'metal' | 'nonmetal' | 'ask'（質問が必要）
   */
  function thresholdClass(group, materialAns) {
    if (materialAns === 'metal' || materialAns === 'nonmetal') return materialAns;
    if (!group) return 'ask';
    const ms = group.materials;
    if (ms.length && ms.every(isMetal)) return 'metal';
    if (ms.length && ms.every(m => !isMetal(m))) return 'nonmetal';
    return 'ask';
  }
  /** 素材の質問が必要か（一番長い辺が 30cm以上50cm未満で、材質で結論が変わる場合のみ） */
  function needsMaterialQuestion(group, L, rules, materialAns) {
    const t = rules.definition;
    if (!(L >= t.metalThresholdCm && L < t.nonMetalThresholdCm)) return false;
    return thresholdClass(group, materialAns) === 'ask';
  }
  /** 境界の近く（±5cm）か。粗大ごみのしきい値と、品目のサイズ区分（長辺1m等）の両方を見る */
  function nearBoundaries(L, group, rules, cls) {
    const t = rules.definition, out = [];
    const ths = cls === 'metal' ? [t.metalThresholdCm] : cls === 'nonmetal' ? [t.nonMetalThresholdCm] : [t.metalThresholdCm, t.nonMetalThresholdCm];
    if (group) group.items.forEach(i => { const c = i.sizeCondition; if (c) ths.push(c.longestLtCm ?? c.longestGteCm); });
    [...new Set(ths)].forEach(th => { if (Math.abs(L - th) <= 5) out.push(th); });
    return out;
  }

  /**
   * 判定（順序：①収集対象外 → ②品目の注記・例外 → ③サイズ基準）
   * input: { group, notInList, L, materialAns, variantMaterial, battery:{has, removable, damaged} }
   * 返り値 type: 'na' | 'unknown' | 'ask-material' | 'small' | 'sodai' | 'phone'
   */
  function determine(input, rules) {
    const { group, notInList } = input;
    const L = Number(input.L);
    if (group && group.notAccepted) return { type: 'na', group };
    if (!Number.isFinite(L) || L <= 0) return { type: 'need-size' };
    const near = nearBoundaries(L, group, rules, thresholdClass(group, input.materialAns));
    const notes = group ? [...new Set(group.items.map(i => i.note).filter(Boolean))] : [];
    if (needsMaterialQuestion(group, L, rules, input.materialAns)) return { type: 'ask-material', L, near, notes };
    const cls = thresholdClass(group, input.materialAns);
    const t = rules.definition;
    const th = cls === 'metal' ? t.metalThresholdCm : cls === 'nonmetal' ? t.nonMetalThresholdCm : (L >= t.nonMetalThresholdCm ? t.nonMetalThresholdCm : t.metalThresholdCm);
    const bySize = cls === 'ask' ? (L >= t.nonMetalThresholdCm ? 'sodai' : 'small') : (L >= th ? 'sodai' : 'small');
    if (notInList || !group) return { type: 'unknown', L, th, cls, near, bySize, notes: [] };
    const battery = group.batteryNote ? (input.battery || null) : null;
    if (bySize === 'small') return { type: 'small', L, th, cls, near, notes, battery };
    // 粗大ごみ：品目内の区分（素材・長辺）を選ぶ
    let cands = group.items.filter(i => sizeOk(i, L));
    let forcedMetal = false;
    if (battery && battery.has && !battery.removable) {
      // 公式注記：バッテリーが外せない等の場合は本体の材質に関わらず「（資）」の品目を選ぶ
      const m = cands.filter(i => i.material === 'metal');
      if (m.length) { cands = m; forcedMetal = true; }
    }
    const vm = input.variantMaterial;
    if (!forcedMetal && vm) { const f = cands.filter(i => i.material === vm || i.materialLabel === vm); if (f.length) cands = f; }
    if (!cands.length) return { type: 'phone', L, th, cls, near, notes, reason: '入力したサイズに当てはまる区分が品目一覧にありません' };
    const fees = new Set(cands.map(i => i.feeYen));
    const variant = cands.length === 1 ? cands[0] : null;
    return { type: 'sodai', L, th, cls, near, notes, variant, cands, feeSame: fees.size === 1, battery, forcedMetal };
  }

  /** 粗大ごみ受付への申込みで聞かれること（メモ） */
  function buildMemo(ctx) {
    const { group, variant, fee, dims, L, method, rules, retrievedAt, cands } = ctx;
    const lines = ['【横浜市 粗大ごみ 申し込みで聞かれること（メモ）】', '※このメモを作っただけでは申し込みは完了していません。'];
    lines.push(`申込み方法：${method === 'self' ? '自分で持ち込む（自己搬入）' : '自宅前などで収集'}`);
    if (variant) lines.push(`品目：${nfkc(variant.officialName)}`);
    else if (cands && cands.length) lines.push(`品目：${group.baseName}（申込み時に次から選ぶ：${cands.map(c => nfkc(c.officialName)).join(' / ')}）`);
    else if (group) lines.push(`品目：${group.baseName}`);
    lines.push(`大きさ：一番長い辺 ${L}cm` + (dims && dims.d && dims.w && dims.h ? `（縦${dims.d}×横${dims.w}×高さ${dims.h}cm）` : ''));
    if (fee) {
      lines.push(`数：${fee.countLabel}${fee.bundleSize > 1 ? `（${fee.setsLabel}）` : ''}`);
      lines.push(`手数料の目安：${fee.formula}（${retrievedAt}時点の品目一覧より。申込み時に表示される金額が正）`);
    }
    const c = rules.collection, s = rules.selfDelivery;
    if (method === 'self') {
      lines.push(`上限：1日${s.maxItemsPerDay}個まで（栄ストックヤードの簡易申込みは${s.sakaeSimpleMaxItems}個まで）`);
      lines.push('締切：インターネット受付は搬入日当日15時まで');
      lines.push('支払い：申込みで金額を確認してから、粗大ごみ収集シールを購入（ヤードでは販売なし）');
    } else {
      lines.push(`上限：1回の申込みは${c.maxItems}個まで`);
      lines.push('締切：収集日の7日前まで');
      lines.push('支払い：申込みで金額を確認してから、シール購入／（ネット・チャット・LINE申込みなら）クレジットカード・PayPay');
      lines.push('当日：収集日の朝8時までに、申込み時に確認した場所へ。シールの氏名欄に受付番号（6桁）と収集日を記入して貼る');
    }
    lines.push('控える：受付番号（6桁）・収集日（搬入日）');
    return lines.join('\n');
  }

  function activeNotices(rules, now) {
    const t = (now || new Date()).getTime();
    return (rules.notices || []).filter(n => (!n.end || t < Date.parse(n.end)) && (!n.start || t >= Date.parse(n.start)));
  }
  function validFees(f) { return !!(f && Array.isArray(f.items) && f.items.length > 100 && typeof f.retrievedAt === 'string' && f.items.every(i => typeof i.officialName === 'string' && 'feeYen' in i)); }
  function validRules(r) { return !!(r && r.schemaVersion >= 5 && r.definition && r.definition.metalThresholdCm === 30 && r.reception && r.reception.phoneLandline && r.collection && r.selfDelivery); }

  const api = { norm, nfkc, yen, expandQuery, buildGroups, search, computeFee, sizeOk, thresholdClass, needsMaterialQuestion, nearBoundaries, determine, buildMemo, activeNotices, validFees, validRules };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SodaiLogic = api;
})(typeof self !== 'undefined' ? self : this);
