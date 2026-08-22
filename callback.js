// Threadsから戻ってくる窓口。
// 受け取った code を「短期トークン → 長期トークン(60日)」に交換する。
// ※STEP3aでは「接続できたか」を確認するだけ（保存はSTEP3bでKVに行う）。

function page(msg, ok = true) {
  const color = ok ? '#6E9A4E' : '#C0703F';
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Threadsにゃんせき</title>
<style>
  body{font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;background:#DBE4CB;color:#42473A;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.8;}
  .card{max-width:400px;background:#FBFDF5;border-radius:24px;padding:34px 26px;text-align:center;
    box-shadow:0 20px 55px rgba(75,64,56,.20);}
  .em{font-size:46px;}
  h1{font-size:20px;color:${color};margin:12px 0 8px;}
  p{font-size:13.5px;color:#5A5241;}
  small{color:#96A085;}
  a{display:inline-block;margin-top:22px;background:#5A5241;color:#fff;text-decoration:none;
    font-weight:700;padding:12px 26px;border-radius:999px;font-size:14px;}
</style></head><body><div class="card">
  <div class="em">${ok ? '🎉🐱' : '⚠️'}</div>
  <h1>${ok ? '接続成功！' : 'エラーが出ました'}</h1>
  <p>${msg}</p>
  <a href="/">トップにもどる</a>
</div></body></html>`;
}

export default async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `https://${host}/api/callback`;
  const { code, error, error_description } = req.query;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (error) {
    return res.status(400).send(page(`認可がキャンセルされました：${error_description || error}`, false));
  }
  if (!code) {
    return res.status(400).send(page('認可コード(code)が受け取れませんでした。', false));
  }

  const appId = process.env.THREADS_APP_ID;
  const appSecret = process.env.THREADS_APP_SECRET;
  if (!appId || !appSecret) {
    return res.status(500).send(page('THREADS_APP_ID / THREADS_APP_SECRET が未設定です（Vercelの環境変数を確認）。', false));
  }

  try {
    // 1) 短期トークン
    const form = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code: String(code),
    });
    const shortRes = await fetch('https://graph.threads.net/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const shortData = await shortRes.json();
    if (!shortData.access_token) {
      throw new Error('短期トークンの取得に失敗：' + JSON.stringify(shortData));
    }

    // 2) 長期トークン（60日）
    const longUrl = `https://graph.threads.net/access_token?grant_type=th_exchange_token`
      + `&client_secret=${encodeURIComponent(appSecret)}`
      + `&access_token=${encodeURIComponent(shortData.access_token)}`;
    const longRes = await fetch(longUrl);
    const longData = await longRes.json();
    if (!longData.access_token) {
      throw new Error('長期トークンの取得に失敗：' + JSON.stringify(longData));
    }

    const days = Math.round((longData.expires_in || 0) / 86400);
    // TODO(STEP3b): longData.access_token を Vercel KV に保存する
    return res.status(200).send(page(
      `あなたのThreadsとつながりました。<br>接続の有効期限：約 <b>${days}日</b><br><br>` +
      `<small>次のステップで、この接続を保存して分析ダッシュボードを表示します🐾</small>`
    ));
  } catch (e) {
    return res.status(500).send(page(String(e.message || e), false));
  }
}
