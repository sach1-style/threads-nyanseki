// 「Threadsでログイン」ボタンの飛び先。
// Threadsの認可画面へリダイレクトする。
export default function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `https://${host}/api/callback`;

  const appId = process.env.THREADS_APP_ID;
  if (!appId) {
    res.status(500).send('設定エラー：THREADS_APP_ID が未設定です（Vercelの環境変数を確認してください）。');
    return;
  }

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: 'threads_basic,threads_manage_insights',
    response_type: 'code',
  });

  res.writeHead(302, { Location: `https://threads.net/oauth/authorize?${params.toString()}` });
  res.end();
}
