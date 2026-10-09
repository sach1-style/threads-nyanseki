// 指定した投稿(mediaId)の返信を取得し、自分の返信と他の人のコメントを分けて返す。
// 自分の返信の表示数・いいね数はインサイトから取得（自分の投稿なので取れる）。
// ※他の人の返信のいいね数はAPIで取得できないため含めない。

const BASE = 'https://graph.threads.net/v1.0';
async function j(url){ const r = await fetch(url); return r.json(); }

export default async function handler(req, res){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const token = process.env.THREADS_ACCESS_TOKEN;
  if(!token) return res.status(500).json({ error: 'THREADS_ACCESS_TOKEN が未設定です' });
  const mediaId = req.query.mediaId;
  if(!mediaId) return res.status(400).json({ error: 'mediaId がありません' });
  const t = encodeURIComponent(token);

  try{
    // 自分のユーザー名（自分の返信の判別に使う）
    const me = await j(`${BASE}/me?fields=username&access_token=${t}`);
    const myName = me.username || null;

    // 返信一覧（最大3ページ）
    let replies = [];
    let url = `${BASE}/${mediaId}/replies?fields=id,username,text,timestamp&limit=100&access_token=${t}`;
    let pages = 0;
    while(url && pages < 3){
      const d = await j(url);
      if(d.error) throw new Error('返信の取得エラー：' + JSON.stringify(d.error) + '（トークンに threads_read_replies が付いているか確認してください）');
      if(Array.isArray(d.data)) replies.push(...d.data);
      url = d?.paging?.next || null;
      pages++;
    }

    const self = replies.filter(r => myName && r.username === myName);
    const others = replies.filter(r => !myName || r.username !== myName);

    // 自分の返信のインサイト（表示・いいね）を合計
    let selfViews = 0, selfLikes = 0, selfDetail = [];
    for(const r of self){
      let v = 0, l = 0;
      try{
        const ins = await j(`${BASE}/${r.id}/insights?metric=views,likes&access_token=${t}`);
        if(Array.isArray(ins.data)){
          for(const it of ins.data){
            const val = it?.total_value?.value ?? it?.values?.[0]?.value ?? 0;
            if(it.name === 'views') v = val;
            if(it.name === 'likes') l = val;
          }
        }
      }catch(e){ /* この返信の数字が取れなくても続行 */ }
      selfViews += v; selfLikes += l;
      selfDetail.push({ text: r.text || '', views: v, likes: l });
    }

    return res.status(200).json({
      me: myName,
      total: replies.length,
      selfCount: self.length,
      otherCount: others.length,
      selfViews, selfLikes, selfDetail,
      others: others.map(r => ({ username: r.username, text: r.text || '', timestamp: r.timestamp })),
    });
  }catch(e){
    return res.status(500).json({ error: String(e.message || e) });
  }
}
