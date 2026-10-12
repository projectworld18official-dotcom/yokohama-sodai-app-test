# 横浜市 粗大ごみナビ（非公式・試用版PWA）

横浜市の粗大ごみについて「出せるか・手数料の目安・申し込み方法」を案内する非公式のモバイルWebアプリ。素のHTML/CSS/JSのみ・ビルド不要。**横浜市の公式アプリではありません。**

## 起動
    python3 -m http.server 8765   # このフォルダで実行
    node tests/unit.test.js        # 単体テスト（パーサ・手数料・境界値・判定順・検索・お知らせ）

## 流れ（v2026-10-12.6）
1. ホーム：「品目名で調べる」＋よく出される物のボタン。名前がわからない時だけ「写真で調べる」（写真は任意、その場合は2〜4枚）
2. 品目：検索（かな・カタカナ同一視、言い換え辞書、逆包含）。0件なら電話ボタン
3. 判定順：①市で回収できない物（寸法を聞かず案内）→②品目一覧の注意書き・バッテリー等の例外→③サイズ基準（一番長い辺：金属製品30cm以上／それ以外50cm以上）
   - 縦・横・高さは3つとも必須（数値検証）。一番長い辺はその最大値を自動表示。素材は30〜50cmで結論が変わる時だけ聞く。基準±5cmは「測り直して」警告
   - 一覧にない物は断定しない（「このアプリでは確定できません。電話で確認」）。公式区分がない組み合わせも電話で確認
4. 結果：手数料の「目安」（computeFee 1か所で計算し、結果・メモ・シール案内で共通使用）。「◯点まで1組」等は ceil(個数/組数)×単価
   - 大きな推奨ボタン1つ（インターネット受付）＋「ほかの方法」（LINE・チャット・電話）
   - 「申し込みで聞かれること」メモとコピー。「ここでは申し込みは完了していません」
   - 収集/持込み切替で上限（9個／1日20個・栄10個）・支払い・メモが変わる
   - 「自分で外まで運べますか？」→ 持ち出し収集・減免の案内（対象かどうかは判断しない）
   - 「公式品目一覧で最終確認」（品目名をコピーしてから開く）＋データ取得日

## AI（任意）
写真ルートの折りたたみ欄で ①送る準備（外部送信の注意と同意）→②Grokで質問→③回答を貼る。AIには**品目名の候補だけ**を聞き、寸法・素材は聞かない（自動入力もしない）。候補は「名称が近い候補」として表示（%表示なし）。写真は追加時にcanvasで縮小・再エンコードするため、位置情報などのEXIFは含まれない。

## プライバシー・保存
- アプリ自体は写真を外部に送らない。AIへの送信は利用者自身の操作のみ
- 入力内容（品目・寸法・手順・AIの回答）は sessionStorage。写真は同意した場合のみ IndexedDB に保存し24時間で削除
- 「続きから再開」、入力途中の更新は確認ダイアログ

## Service Worker
- キャッシュ名は `yokohama-sodai-nav-<版>`。削除するのはこの接頭辞の古いキャッシュだけ
- 失敗した応答（非200）は保存しない。data/*.json は形を検査し、壊れたデータで保存済みデータを上書きしない
- オフラインで保存済みデータを使っている時は画面に表示

## データ更新手順
1. `python3 tools/update_fees.py fetch` … 公式品目一覧の内部データを取得（日本語セッション）→ tools/raw-dustlist.json
2. `python3 tools/update_fees.py diff` … 手数料・名称・注記の変更、新規・削除品目を確認
3. `python3 tools/update_fees.py apply YYYY-MM-DD` … 既存品目を更新し取得日を変更、まとめ数え等を再計算（新規・削除は内容を見て手作業）
4. data/rules.json … 公式ページを確認して更新（schemaVersion 5 以上が必須）。期間限定のお知らせは `notices`（start/end を過ぎると自動で非表示）
5. `node tests/unit.test.js` を通し、APP_VERSION（app.js）と VERSION（sw.js）を上げる

公式データは548件。うち1件（dustType 5「電子決済持込み用品目」code 646）は公式の品目一覧ページにも表示されない内部用のため除外し、547件を収録（テストで検証）。

## 主な出典
- 品目・手数料：https://www.sodai.city.yokohama.lg.jp/eco/view/yokohama/dustlistSearch.html?newwindow=true
- 粗大ごみの定義：https://www.city.yokohama.lg.jp/kurashi/sumai-kurashi/gomi-recycle/gomi/shushu/sodaigomi/chuui/chuuijikou.html
- 収集・シール：https://www.city.yokohama.lg.jp/kurashi/sumai-kurashi/gomi-recycle/gomi/shushu/sodaigomi/dashikata/shuushuu.html
- 電池類：https://www.city.yokohama.lg.jp/kurashi/sumai-kurashi/gomi-recycle/gomi/batteries.html
- 持ち出し収集：https://www.city.yokohama.lg.jp/kurashi/sumai-kurashi/gomi-recycle/shien/motidasi.html
- 減免：https://www.city.yokohama.lg.jp/kurashi/sumai-kurashi/gomi-recycle/gomi/shushu/sodaigomi/dashikata/genmen.html
- その他は data/rules.json の各 source / url
