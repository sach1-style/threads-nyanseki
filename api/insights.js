// あなたのThreadsから「投稿一覧＋各投稿の数字」を取ってきて、画面に渡す裏方。
// トークンは Vercel の環境変数 THREADS_ACCESS_TOKEN から読む（画面には出さない）。

const BASE = 'https://graph.threads.net/v1.0';

async function getJSON(url) {
  const r = await fetch(url);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'THREADS_ACCESS_TOKEN が未設定です（Vercelの環境変数を確認してください）。' });
  }
  const t = encodeURIComponent(token);

  try {
    // プロフィール
    const me = await getJSON(`${BASE}/me?fields=username,name&access_token=${t}`);
    if (me.error) throw new Error('プロフィール取得エラー：' + JSON.stringify(me.error));

    // フォロワー数（取れなければ null）
    let followers = null;
    try {
      const fi = await getJSON(`${BASE}/me/threads_insights?metric=followers_count&access_token=${t}`);
      followers = fi?.data?.[0]?.total_value?.value ?? null;
    } catch (e) { /* noop */ }

    // 投稿一覧（最大3ページ）
    let posts = [];
    let url = `${BASE}/me/threads?fields=id,media_type,media_product_type,text,permalink,timestamp,is_quote_post&limit=100&access_token=${t}`;
    let pages = 0;
    while (url && pages < 2 && posts.length < 200) { // まずは最大200投稿（重さ対策。全期間対応はSTEP2で）
      const d = await getJSON(url);
      if (d.error) throw new Error('投稿一覧の取得エラー：' + JSON.stringify(d.error));
      if (Array.isArray(d.data)) posts.push(...d.data);
      url = d?.paging?.next || null;
      pages++;
    }

    // 各投稿の数字（並列・8件ずつ）
    const out = [];
    const CHUNK = 8;
    for (let i = 0; i < posts.length; i += CHUNK) {
      const slice = posts.slice(i, i + CHUNK);
      const results = await Promise.all(slice.map(async (p) => {
        const m = { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0 };
        try {
          const ins = await getJSON(`${BASE}/${p.id}/insights?metric=views,likes,replies,reposts,quotes,shares&access_token=${t}`);
          if (Array.isArray(ins.data)) {
            for (const it of ins.data) {
              const v = it?.total_value?.value ?? it?.values?.[0]?.value ?? 0;
              if (Object.prototype.hasOwnProperty.call(m, it.name)) m[it.name] = v;
            }
          }
        } catch (e) { /* この投稿の数字が取れなくても0で続行 */ }
        return {
          id: p.id,
          ts: p.timestamp,
          type: p.media_type,
          product: p.media_product_type,
          text: p.text || '',
          permalink: p.permalink,
          is_quote: !!p.is_quote_post,
          ...m,
        };
      }));
      out.push(...results);
    }

    return res.status(200).json({
      username: me.username || null,
      followers,
      count: out.length,
      fetchedAt: new Date().toISOString(),
      posts: out,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
