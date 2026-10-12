# 横浜市 粗大ごみナビ（試作PWA）

写真（2枚以上）→ 品目確定 → 縦・横・高さ（cm）入力 → 粗大ごみ判定・手数料・申込み〜当日の手順、までを案内する横浜市限定のモバイルWebアプリ試作版。
素のHTML/CSS/JSのみ・ビルド不要。

## 起動
    cd yokohama-sodai-app && python3 -m http.server 8765
    # スマホ実機でカメラを使うには HTTPS（または localhost）で配信してください

## 構成
- index.html / style.css / app.js … UI・判定ロジック
- recognizer.js … **画像認識フック**（現状はプレースホルダー。差し替え方法はファイル冒頭コメント参照）
- data/fees.json … 公式品目一覧（547品目, 取得日 2026-10-12, 出典URL付き）
- data/rules.json … 定義・受付・支払・収集・持込み・回収不可品目のルール（各出典URL付き）
- manifest.webmanifest / sw.js / icons/ … PWA

## 判定ロジック
1. 回収不可品目（家電4品目・パソコン・バイク・消火器・ピアノ等）→ 受付不可＋処分先案内
2. 一番長い辺 = max(縦,横,高さ)。主素材が金属なら30cm以上、それ以外は50cm以上で粗大ごみ（横浜市公式基準）
3. 粗大ごみの場合、同じ品目・素材の中から「長辺1m未満/以上」「長辺80cm未満/以上」等のサイズ区分を寸法で自動選択し手数料を表示
4. 一覧にない物 → 素材を質問し判定、電話申込みを案内

## 写真からの品目特定（既定：Grokガイド方式・有料API不要）
写真が2枚以上になると「Grokで写真を調べる」欄が表示されます（任意。使わずに一覧から手動で選んでもOK）。
1. 「Grokとは？」の紹介、iPhone（App Store）/ Android（Google Play）/ ブラウザ（grok.com）への導線（端末をUAで判定して強調）
2. 定型プロンプトをワンタップでコピー（navigator.clipboard、非対応時は execCommand('copy')）、grok.com を新しいタブで開く
3. 写真①②をcanvasで横並び1枚のJPEG（sodai-photos.jpg、高さ約1024px、2MB以下）にまとめる。Web Share API対応端末は「写真を共有」でその1枚をGrokアプリへ（Grokアプリは共有で1枚しか受け付けないため）、ブラウザ利用者は「まとめ画像を保存」して添付
4. Grokの回答を貼り付け →「回答を読み取る」で、品目名・素材・縦横高さ・回収対象外の可能性を解析（recognizer.js の SodaiGrokGuide.parseReply）
5. 品目ステップで公式品目一覧の候補を提示、素材を事前選択、サイズ欄に推定値を仮入力（黄色）。推定値を使った場合は「確認しました」チェックが必須
6. 判定・手数料は常に横浜市公式データ（data/fees.json, data/rules.json）で計算

無料プランで足りるよう、1回のメッセージ（まとめ画像1枚＋文章1つ）で完結する設計です。画像生成・DeepSearch等は使いません。

### 自動認識に差し替える場合（任意）
`window.SodaiRecognizer.recognize(files, catalog, { grokReply })` が同じ形
（`{candidates:[{baseName, confidence, material}], material, estimatedDims:{d,w,h}, notAcceptedHint}`）を返せば、
recognizer.js より後に読み込むスクリプトで差し替えられます。外部APIを使う場合もキーはブラウザに置かずサーバー側で扱ってください。

## 注意
本アプリは横浜市の公式アプリではありません。手数料・ルールは変更される可能性があり、申込み時の公式表示が正です。

## LINE申込み
粗大ごみ判定の結果画面に「LINEで申し込む（横浜市公式）」ボタン。タップで申し込みメモ（品目・公式品目名・素材・寸法・個数・手数料・支払い方法）をコピー＆画面表示し、横浜市LINE公式アカウント（@cityofyokohama, https://page.line.me/314eefow?openQrModal=true ／出典 https://www.city.yokohama.lg.jp/city-info/koho-kocho/koho/sns/line/line-official.html ）を開く。メニュー「粗大ごみ」から申込み。収集申込みはクレジットカード／PayPayの電子決済可。
