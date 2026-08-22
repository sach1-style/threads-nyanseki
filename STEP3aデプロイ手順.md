# 🚀 STEP 3a デプロイ手順 ―「接続成功！」を確認する

目的：アプリを公開して、「Threadsでログイン」→「接続成功！」まで通す。
（分析ダッシュボードの中身は、これが通ったあとのSTEP 3bで作ります）

---

## ① GitHubに新しい倉庫を作ってアップ
1. https://github.com/new を開く（`sach1-style` でログイン）
2. Repository name：`threads-nyanseki`／**Public**／**Create repository**
3. できたページで「uploading an existing file」→
   フォルダ `LP作成関連 ＞ threads-analytics-app` の中身を**ドラッグ＆ドロップ**
   - ⚠️ **`api` フォルダ（中の auth.js / callback.js）も一緒に**アップすること！
   - `index.html` `package.json` `cats.png` `api/` を必ず含める
4. 「Commit changes」

## ② Vercelで公開
1. https://vercel.com/new を開く
2. `threads-nyanseki` を **Import**
3. 設定は変えずに **Deploy**
4. 公開できたら、URLを確認してメモ（例：`https://threads-nyanseki.vercel.app`）
   → これを **本番URL** と呼びます

## ③ Vercelの金庫にキーを入れる（環境変数）
1. Vercelの `threads-nyanseki` プロジェクト → **Settings → Environment Variables**
2. 次の2つを追加（値は、控えておいた**Threads用**のほう）：
   | Name（そのまま入力） | Value |
   |---|---|
   | `THREADS_APP_ID` | あなたの **Threads App ID** |
   | `THREADS_APP_SECRET` | あなたの **Threads App Secret** |
3. 保存したら、**Deployments → 最新のを Redeploy**（環境変数を反映させるため）

## ④ Metaにリダイレクト先を登録
1. Meta開発者ダッシュボード → アプリ → **ユースケース「Threads API を利用」→ 設定/カスタマイズ**
2. **「リダイレクトURI（Redirect Callback URLs）」** の欄に、次を登録：
   ```
   https://（あなたの本番URL）/api/callback
   ```
   例：`https://threads-nyanseki.vercel.app/api/callback`
3. 保存

## ⑤ ログインを試す！
1. 本番URL（`https://（あなたの本番URL）`）をスマホ or PCで開く
2. **「🧵 Threadsでログイン」** を押す
3. Threadsの「許可しますか？」画面で **許可**
4. **「🎉 接続成功！」** と出れば大成功！🐱🎉

---

## ⚠️ うまくいかない時（よくある原因）
- **「設定エラー：THREADS_APP_ID が未設定」** → ③のあと Redeploy し忘れ／名前のスペル違い
- **「redirect_uri が一致しない」系のエラー** → ④のURLが本番URLと1文字でも違う（末尾 `/api/callback` まで正確に）
- **認可画面で権限が出ない** → 自分がThreadsテスターに追加＆承認済みか確認
- どんなエラーでも、**画面のメッセージをスクショで送って**もらえれば、私が原因を特定します📷

---

## この次（STEP 3b）
「接続成功！」が出たら教えてください。私が
1. 接続を安全に保存する仕組み（無料の保存場所）
2. 投稿データを取得して、あのイメージ図に実データを流し込む
を作ります📊🐾
