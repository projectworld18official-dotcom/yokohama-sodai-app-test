#!/usr/bin/env python3
"""横浜市 粗大ごみ品目一覧データの更新補助スクリプト（標準ライブラリのみ）

使い方:
  python3 tools/update_fees.py fetch            # 公式の品目一覧データを取得 → tools/raw-dustlist.json
  python3 tools/update_fees.py diff             # 取得データと data/fees.json の差分を表示（変更はしない）
  python3 tools/update_fees.py apply YYYY-MM-DD # 既存品目の手数料・名称・注記を更新し、取得日を書き換え
  python3 tools/update_fees.py enrich           # まとめ数え（◯点まで1組 等）・バッテリー注記の派生項目を再計算
新規品目・削除品目は diff に表示されるので、内容を確認して手で追加・削除してください。
"""
import json, re, sys, unicodedata, urllib.request, http.cookiejar, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEES = os.path.join(ROOT, 'data', 'fees.json')
RAW = os.path.join(ROOT, 'tools', 'raw-dustlist.json')
BASE = 'https://www.sodai.city.yokohama.lg.jp/eco/view/yokohama/'
BODY = '0=0&1=&2=false&AjaxParam0=0&AjaxParam1=&AjaxParam2=false&component=dustPage&action=ajaxGetDustAllList&time=x'
# dustType 5 は電子決済の持込み用内部品目（公式の一覧ページ自体が表示しない）。アプリでも除外する。
SKIP_TYPES = {5}

def nk(s): return unicodedata.normalize('NFKC', s or '')

def fetch():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [('User-Agent', 'Mozilla/5.0'), ('Accept-Language', 'ja')]
    op.open(BASE + 'dustlistSearch.html?newwindow=true').read()  # 日本語セッションを作る
    req = urllib.request.Request(BASE + 'teeda.ajax', data=BODY.encode(), headers={'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest'})
    data = json.loads(op.open(req).read().decode('utf-8'))
    if not isinstance(data, list) or len(data) < 100 or 'dustName' not in data[0]:
        sys.exit('取得データの形式が想定外です。保存しません。')
    json.dump(data, open(RAW, 'w'), ensure_ascii=False, indent=0)
    shown = [d for d in data if d.get('dustType') not in SKIP_TYPES]
    print(f'取得 {len(data)} 件（うち公式一覧に表示される品目 {len(shown)} 件）→ {RAW}')

def load():
    raw = [d for d in json.load(open(RAW)) if d.get('dustType') not in SKIP_TYPES]
    fees = json.load(open(FEES))
    return {d['dustCode']: d for d in raw}, fees

def diff(apply_date=None):
    raw, fees = load()
    cur = {i['code']: i for i in fees['items']}
    for c in sorted(set(raw) - set(cur)): print('新規', c, raw[c]['dustName'], raw[c]['tanka'])
    for c in sorted(set(cur) - set(raw)): print('削除', c, cur[c]['officialName'])
    n = 0
    for c in sorted(set(raw) & set(cur)):
        r, i = raw[c], cur[c]
        fee = None if r.get('dustType') == 4 else r['tanka']
        ch = []
        if fee != i['feeYen']: ch.append(f"手数料 {i['feeYen']}→{fee}")
        if r['dustName'] != i['officialName']: ch.append(f"名称 {i['officialName']}→{r['dustName']}")
        if (r.get('html_memo') or '').strip() != '' and nk(re.sub(r'<[^>]+>', ' ', r['html_memo'])).split()[:3] != nk(i['note']).split()[:3]: ch.append('注記変更の可能性')
        if ch:
            n += 1; print('変更', c, ' / '.join(ch))
            if apply_date:
                i['feeYen'] = i['selfDeliveryFeeYen'] = fee
                i['officialName'] = r['dustName']
    print(f'変更 {n} 件')
    if apply_date:
        fees['retrievedAt'] = apply_date
        fees['count'] = len(fees['items'])
        json.dump(fees, open(FEES, 'w'), ensure_ascii=False, indent=1)
        enrich()

BUNDLE_PATTERNS = [
    (r'\((\d+)(点|枚|本|個)まで(?:を)?1組(?:に)?\)', 'name'),   # クッション(5点まで1組) 布団&マットレス(2枚まで1組に) 自転車の車輪(2個までを1組)
    (r'(\d+)(本)までを1組', 'name'),                           # 釣り竿(15本までを1組)
    (r'\((\d+)(本)1組\)', 'name'),                             # 松葉杖(2本1組)
    (r'(\d+)(本)まで\)', 'name'),                              # 鉄アレイ(2本まで) スピーカー(2本まで)
    (r'^[^。]*?(?<!レール\(バー\)は)(\d+)(本)までを1組として', 'note'),  # ゴルフクラブ・ハンガー（キャリアのレールは除外）
    (r'^(\d+)(本)まで$', 'note'),                              # 物干竿(突っ張りタイプ)
]

def enrich():
    fees = json.load(open(FEES))
    for i in fees['items']:
        i['bundle'] = None
        name, note = nk(i['officialName']), nk(i['note']).strip()
        for pat, where in BUNDLE_PATTERNS:
            m = re.search(pat, name if where == 'name' else note)
            if m:
                i['bundle'] = {'size': int(m.group(1)), 'unit': m.group(2), 'source': where}
                break
        if i['code'] == 613:  # 突っ張り棒：直径5cm未満は15本まで200円（長さは2mまで）
            i['bundle'] = {'size': 15, 'unit': '本', 'source': 'note', 'condition': '直径5cm未満・長さ2mまで。直径5cm以上は電話・チャット等で問合せ'}
        i['batteryNote'] = 'バッテリー付きの品物' in note
    fees['notes'] = [
        'feeYenは「1点」または「1組（bundle.size点まで）」あたりの処理手数料（円）。収集・自己搬入とも同額（公式: 市が収集する場合と同じ処理手数料）。',
        'bundleは品目名・注記の「◯点まで1組」「◯本までを1組」等から機械的に抽出したもの。合計 = ceil(個数 / bundle.size) × feeYen。',
        'sizeConditionは品目名に記載の「長辺」条件をcmに換算したもの。',
        'notAccepted=trueは市で回収できない品目（品目一覧に【受付不可】として掲載）。',
        '公式データは548件だが、うち1件（dustType 5「電子決済持込み用品目」code 646）は公式の品目一覧ページにも表示されない内部用のため除外し、count件を収録。',
    ]
    fees['count'] = len(fees['items'])
    json.dump(fees, open(FEES, 'w'), ensure_ascii=False, indent=1)
    print('enrich:', sum(1 for i in fees['items'] if i['bundle']), '品目にまとめ数え,', sum(1 for i in fees['items'] if i['batteryNote']), '品目にバッテリー注記')

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'fetch': fetch()
    elif cmd == 'diff': diff()
    elif cmd == 'apply' and len(sys.argv) > 2: diff(sys.argv[2])
    elif cmd == 'enrich': enrich()
    else: print(__doc__)
