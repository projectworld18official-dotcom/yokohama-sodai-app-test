// node tests/unit.test.js
const assert = require('assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const L = require('../logic.js');
const root = path.join(__dirname, '..');
const fees = JSON.parse(fs.readFileSync(path.join(root, 'data/fees.json')));
const rules = JSON.parse(fs.readFileSync(path.join(root, 'data/rules.json')));
const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(root, 'recognizer.js'), 'utf8'), ctx);
const G = ctx.window.SodaiGrokGuide;
const groups = L.buildGroups(fees);
const g = n => groups.find(x => x.baseName === n);
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('データ形', () => { assert(L.validFees(fees)); assert(L.validRules(rules)); assert.strictEqual(fees.items.length, fees.count); assert.strictEqual(L.validFees({ items: [] }), false); assert.strictEqual(L.validRules({}), false); });
t('547/548：公式生データ548件−内部品目1件', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'tools/raw-dustlist.json')));
  const hidden = raw.filter(d => d.dustType === 5);
  assert.strictEqual(raw.length - hidden.length, fees.items.length);
  assert.deepStrictEqual(hidden.map(d => d.dustCode), [646]);
});
// 長さパーサ
t('単位 mm/cm/m', () => {
  assert.strictEqual(G.parseLengthCm('5mm'), 0.5);
  assert.strictEqual(G.parseLengthCm('500mm'), 50);
  assert.strictEqual(G.parseLengthCm('1.2m'), 120);
  assert.strictEqual(G.parseLengthCm('120'), 120);
  assert.strictEqual(G.parseLengthCm('１２０ｃｍ'), 120);
  assert.strictEqual(G.parseLengthCm('80センチ'), 80);
  assert.strictEqual(G.parseLengthCm('abc'), null);
  assert.deepStrictEqual([...G.parseDims('1.2m×0.5m×0.6m')], [120, 50, 60]);
  assert.deepStrictEqual([...G.parseDims('120x50x60cm')], [120, 50, 60]);
});
t('素材の否定', () => {
  assert.strictEqual(G.classifyMaterial('非金属'), 'nonmetal');
  assert.strictEqual(G.classifyMaterial('金属以外（プラスチック）'), 'nonmetal');
  assert.strictEqual(G.classifyMaterial('金属ではない'), 'nonmetal');
  assert.strictEqual(G.classifyMaterial('スチール'), 'metal');
  assert.strictEqual(G.classifyMaterial('木'), 'nonmetal');
});
t('回答パーサ（名前のみ・寸法は読まない）', () => {
  const p = G.parseReply('**品目名**：たんす（整理たんす）\n別名候補：チェスト、衣装ケース\n縦：45cm\n回収対象外の可能性：なし');
  assert.strictEqual(p.itemName, 'たんす'); assert.deepStrictEqual([...p.aliases], ['チェスト', '衣装ケース']);
  assert.strictEqual(p.dims, undefined);
  const c = G.matchCandidates(p, { groups });
  assert.strictEqual(c[0].baseName, 'たんす'); assert.strictEqual(c[0].how, 'exact'); assert(!('confidence' in c[0]));
  assert(G.naHint(G.parseReply('品目名：冷蔵庫\n回収対象外の可能性：家電リサイクル法対象'), { notAccepted: rules.notAccepted }).rule.key === 'kaden4');
  assert(!/縦|横|高さ|素材/.test(G.PROMPT.split('\n').filter(l => /：/.test(l)).join('')));
});
// 手数料
t('まとめ数え（5点まで1組）', () => {
  const v = fees.items.find(i => i.officialName.includes('クッション(長辺1m未満)'));
  let f = L.computeFee(v, 1); assert.strictEqual(f.totalYen, 200); assert.strictEqual(f.sets, 1);
  f = L.computeFee(v, 5); assert.strictEqual(f.totalYen, 200);
  f = L.computeFee(v, 6); assert.strictEqual(f.totalYen, 400); assert.strictEqual(f.sets, 2); assert.strictEqual(f.unitLabel, '1組（5点まで）あたり');
  const fu = fees.items.find(i => i.officialName.includes('布団＆マットレス'));
  f = L.computeFee(fu, 3); assert.strictEqual(f.unit, '枚'); assert.strictEqual(f.totalYen, 400);
  const go = fees.items.find(i => i.officialName === '資)ゴルフクラブ');
  assert.strictEqual(L.computeFee(go, 15).totalYen, 200); assert.strictEqual(L.computeFee(go, 16).totalYen, 400);
  const tansu = g('たんす').items[0];
  f = L.computeFee(tansu, 3); assert.strictEqual(f.totalYen, tansu.feeYen * 3); assert.strictEqual(f.unitLabel, '1点あたり');
  assert.strictEqual(L.computeFee(fees.items.find(i => i.code === 410), 1).bundleSize, 1); // チェーン：一式（数えない）
  assert.strictEqual(fees.items.find(i => i.code === 408).bundle, null); // キャリアのレール2本は本体の数え方ではない
});
t('メモはcomputeFeeの結果を使う', () => {
  const v = fees.items.find(i => i.officialName.includes('クッション(長辺1m未満)'));
  const fee = L.computeFee(v, 7);
  const m = L.buildMemo({ group: g(v.baseName), variant: v, fee, dims: {}, L: 60, method: 'collect', rules, retrievedAt: '2026-10-12' });
  assert(m.includes('400円')); assert(m.includes('2組')); assert(m.includes('完了していません')); assert(m.includes('9個'));
  const ms = L.buildMemo({ group: g(v.baseName), variant: v, fee, dims: {}, L: 60, method: 'self', rules, retrievedAt: '2026-10-12' });
  assert(ms.includes('20個') && ms.includes('10個') && !ms.includes('9個'));
  assert(!m.includes('氏名を記入')); assert(m.includes('氏名欄に受付番号（6桁）と収集日'));
});
// 判定（境界・順序）
const bike = g('自転車(子供用自転車を含む)'), sofa = g('ソファー(2人以上用)');
const metalOnly = groups.find(x => !x.notAccepted && x.materials.length && x.materials.every(m => m === 'metal') && x.items.every(i => !i.sizeCondition));
const nonOnly = groups.find(x => !x.notAccepted && x.materials.length && x.materials.every(m => m !== 'metal') && x.items.every(i => !i.sizeCondition));
t('境界 金属 29.9 / 30', () => {
  assert.strictEqual(L.determine({ group: metalOnly, L: 29.9 }, rules).type, 'small');
  assert.strictEqual(L.determine({ group: metalOnly, L: 30 }, rules).type, 'sodai');
});
t('境界 金属以外 49.9 / 50', () => {
  assert.strictEqual(L.determine({ group: nonOnly, L: 49.9 }, rules).type, 'small');
  assert.strictEqual(L.determine({ group: nonOnly, L: 50 }, rules).type, 'sodai');
});
t('素材は30〜50cmの時だけ聞く', () => {
  const mixed = groups.find(x => !x.notAccepted && x.materials.includes('metal') && x.materials.some(m => m !== 'metal'));
  assert.strictEqual(L.determine({ group: mixed, L: 29.9 }, rules).type, 'small');
  assert.strictEqual(L.determine({ group: mixed, L: 40 }, rules).type, 'ask-material');
  assert.strictEqual(L.determine({ group: mixed, L: 40, materialAns: 'metal' }, rules).type, 'sodai');
  assert.strictEqual(L.determine({ group: mixed, L: 40, materialAns: 'nonmetal' }, rules).type, 'small');
  assert.notStrictEqual(L.determine({ group: mixed, L: 50 }, rules).type, 'ask-material');
});
t('±5cmで測り直し警告', () => {
  assert.deepStrictEqual(L.nearBoundaries(47, nonOnly, rules, 'nonmetal'), [50]);
  assert.deepStrictEqual(L.nearBoundaries(60, nonOnly, rules, 'nonmetal'), []);
  assert(L.nearBoundaries(97, g('カラーボックス'), rules, 'nonmetal').includes(100));
});
t('順序：収集対象外が最優先（寸法なしでも）', () => {
  const ac = groups.find(x => x.baseName === 'エアコン');
  assert.strictEqual(L.determine({ group: ac, L: NaN }, rules).type, 'na');
  assert.strictEqual(L.determine({ group: ac, L: 10 }, rules).type, 'na');
});
t('一覧にない物は断定しない', () => {
  assert.strictEqual(L.determine({ group: null, notInList: true, L: 200, materialAns: 'nonmetal' }, rules).type, 'unknown');
  assert.strictEqual(L.determine({ group: null, notInList: true, L: 10 }, rules).type, 'unknown');
  assert.strictEqual(L.determine({ group: null, notInList: true, L: 40 }, rules).type, 'ask-material');
});
t('注記は粗大ごみでなくても返す', () => {
  const r = L.determine({ group: g('ハンガー'), L: 20 }, rules);
  assert.strictEqual(r.type, 'small'); assert(r.notes.length > 0);
});
t('サイズ区分の自動選択', () => {
  const z = g('座卓');
  assert.strictEqual(L.determine({ group: z, L: 99.9 }, rules).cands.every(i => i.sizeCondition.longestLtCm === 100), true);
  assert.strictEqual(L.determine({ group: z, L: 100 }, rules).cands.every(i => i.sizeCondition.longestGteCm === 100), true);
  // 公式の区分がない組合せ（カラーボックスは「長辺1m未満」のみ）→ 電話で確認
  assert.strictEqual(L.determine({ group: g('カラーボックス'), L: 100 }, rules).type, 'phone');
});
t('バッテリー：外せない→（資）の品目', () => {
  const sj = g('掃除機');
  const r = L.determine({ group: sj, L: 100, battery: { has: true, removable: false, damaged: false } }, rules);
  assert.strictEqual(r.type, 'sodai'); assert.strictEqual(r.variant.officialName, '資)掃除機'); assert(r.forcedMetal);
  const r2 = L.determine({ group: sj, L: 100, variantMaterial: 'burnable', battery: { has: true, removable: true } }, rules);
  assert.strictEqual(r2.variant.officialName, '可)掃除機');
  assert(rules.battery.car.includes('収集できない'));
});
t('検索：言い換え・逆包含・かな', () => {
  const top = q => (L.search(groups, q)[0] || {}).baseName;
  assert(/ベッド/.test(top('ベット')));
  assert.strictEqual(top('石油ストーブ'), 'ストーブ類');
  assert.strictEqual(top('電気カーペット'), 'カーペット類');
  assert(/布団/.test(top('羽毛布団')));
  assert(/布団/.test(top('ふとん')));
  assert.strictEqual(top('乳母車'), 'ベビーカー');
  assert.strictEqual(top('タンス'), 'たんす');
  assert(L.search(groups, '木製の本棚').some(x => x.baseName === '書棚'));
  assert.strictEqual(L.search(groups, 'zzzz').length, 0);
});
t('お知らせは終了時刻で消える', () => {
  assert.strictEqual(L.activeNotices(rules, new Date('2026-10-12T12:00:00+09:00')).length, 2);
  assert.strictEqual(L.activeNotices(rules, new Date('2026-10-20T12:00:00+09:00')).length, 1);
  assert.strictEqual(L.activeNotices(rules, new Date('2026-10-26T08:30:00+09:00')).length, 0);
});
t('電話番号はrules.jsonのみ', () => {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert(!/0570-?200-?530|045-?330-?3953/.test(app));
});
console.log(`\n${n} tests passed`);
