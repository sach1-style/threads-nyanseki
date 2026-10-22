// 指定した日（日本時間 0:00〜23:59）に自分がした返信を集め、会話を1対1に組み立てて返す裏方。
// 自分の投稿への返信も、相手の投稿への返信も含む。
// root_post が空の返信（相手の投稿でよくある）は、replied_to から上へたどって元投稿を特定する。

const BASE = 'https://graph.threads.net/v1.0';
async function j(url){ const r = await fetch(url); return r.json(); }
function rootIdOf(rp){ if(!rp) return null; if(typeof rp === 'string') return rp; return rp.id || null; }

export default async function handler(req, res){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const token = process.env.THREADS_ACCESS_TOKEN;
  if(!token) return res.status(500).json({ error: 'THREADS_ACCESS_TOKEN が未設定です' });
  const t = encodeURIComponent(token);

  // 対象日（渡されなければ日本時間の「前日」）
  let date = (req.query.date||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){
    const now = new Date();
    const jstNow = new Date(now.getTime() + 9*3600*1000);
    jstNow.setUTCDate(jstNow.getUTCDate()-1);
    date = `${jstNow.getUTCFullYear()}-${String(jstNow.getUTCMonth()+1).padStart(2,'0')}-${String(jstNow.getUTCDate()).padStart(2,'0')}`;
  }
  const targetStart = Date.parse(date+'T00:00:00+09:00');
  const targetEnd = targetStart + 86400000;

  try{
    const me = await j(`${BASE}/me?fields=username&access_token=${t}`);
    const myName = me.username || null;

    // 自分の投稿（own/other 判定＆本文表示用）。最大4ページ。
    const myPosts = new Map(); // id -> {text, permalink}
    {
      let url = `${BASE}/me/threads?fields=id,text,permalink&limit=100&access_token=${t}`, pages = 0;
      while(url && pages < 4){
        const d = await j(url);
        if(d.error) break;
        for(const p of (d.data||[])) myPosts.set(String(p.id), { text: p.text||'', permalink: p.permalink||null });
        url = d?.paging?.next || null; pages++;
      }
    }

    // 自分の返信をページ送りで取得（新しい順。対象日より古くなったら打ち切り）
    let myReplies = [];
    {
      let url = `${BASE}/me/replies?fields=id,text,timestamp,username,permalink,root_post{id},replied_to{id}&limit=100&access_token=${t}`;
      let pages = 0, stop = false;
      while(url && pages < 8 && !stop){
        const d = await j(url);
        if(d.error) throw new Error('返信一覧の取得エラー：' + JSON.stringify(d.error) + '（トークンに threads_read_replies が付いているか確認してください）');
        for(const r of (Array.isArray(d.data)?d.data:[])){
          const tms = Date.parse(r.timestamp);
          if(tms >= targetStart && tms < targetEnd) myReplies.push(r);
          if(tms < targetStart) stop = true;
        }
        url = (!stop && d?.paging?.next) ? d.paging.next : null;
        pages++;
      }
    }
    const fetchedReplies = myReplies.length;

    // --- 探索の共有キャッシュ＆安全上限 ---
    const nodeCache = new Map(); // id -> {id,username,text,ts,parent}
    let fetchBudget = 220;       // 追加探索で使えるAPI呼び出しの上限
    const norm = (o, parentKnown)=>({ id:String(o.id), username:o.username||null, text:o.text||'', ts:Date.parse(o.timestamp)||0, parent: o.replied_to ? String(rootIdOf(o.replied_to)) : (parentKnown||null) });
    async function getNode(id){
      id = String(id);
      if(nodeCache.has(id)) return nodeCache.get(id);
      if(fetchBudget <= 0) return null;
      fetchBudget--;
      let o; try{ o = await j(`${BASE}/${id}?fields=id,username,text,timestamp,replied_to{id}&access_token=${t}`); }catch(e){ return null; }
      if(!o || o.error) return null;
      const m = norm(o); nodeCache.set(id, m); return m;
    }
    // 返信の root を解決（root_post が無ければ replied_to から上へたどる）
    async function resolveRoot(r){
      const direct = rootIdOf(r.root_post);
      if(direct) return String(direct);
      let pid = rootIdOf(r.replied_to);
      let depth = 0;
      while(pid && depth < 8){
        const node = await getNode(pid);
        if(!node) return String(pid);          // これ以上たどれない→暫定で親を root 扱い
        if(!node.parent) return String(node.id); // 親なし＝元投稿
        pid = node.parent; depth++;
      }
      return pid ? String(pid) : null;
    }

    // ピン紹介（無料ガイド/ピン留め/ピン止め/URL）を自分の発言から判定
    const PIN_RE = /無料ガイド|ピン留め|ピン止め|ピンどめ|https?:\/\//;
    const hasPin = (messages)=> (messages||[]).some(m=> m.who==='me' && PIN_RE.test(m.text||''));

    // items から相手ごとに1対1の会話へ整理
    function buildConvs(items, rid, rootAuthor, rootOwnerIsMe, rootText, rootPermalink){
      const authorById = {}; items.forEach(m=> authorById[String(m.id)]=m.username);
      const parentAuthor = (m)=>{
        if(!m.parent) return null;
        if(m.parent === String(rid)) return rootAuthor;
        return authorById[m.parent] || null;
      };
      const others = Array.from(new Set(items.map(m=>m.username).filter(u=> u && u!==myName)));
      const out = [];
      for(const u of others){
        const exchange = items.filter(m=>{
          if(m.username === u){ const pa = parentAuthor(m); return pa === myName || m.parent === String(rid) || pa === null; }
          if(m.username === myName){ return parentAuthor(m) === u; }
          return false;
        });
        const myMsgs = exchange.filter(m=> m.username===myName);
        const uN = exchange.filter(m=> m.username===u).length;
        if(myMsgs.length < 1 || uN < 1) continue;
        let round = myMsgs.filter(m=> parentAuthor(m)===u).length;
        if(round < 1) round = Math.min(myMsgs.length, uN);
        const thread = exchange.slice().sort((a,b)=> a.ts-b.ts)
          .map(m=>({ who: m.username===myName ? 'me':'other', text: (m.text||'').slice(0,200) }));
        out.push({ rootId: rid, rootOwnerIsMe, rootText, rootPermalink, otherName: u, round, messages: thread });
      }
      return out;
    }

    // 相手の投稿：自分の返信を起点に、上（replied_to）と下（/replies）へたどって会話を組み立てる
    async function walkOthersRoot(rid, myOnRoot, rootAuthor, rootText, rootPermalink){
      const collected = new Map();
      const add = (m)=>{ if(m && m.id && !collected.has(String(m.id))) collected.set(String(m.id), m); };
      const rootNode = nodeCache.get(String(rid)); if(rootNode) add(rootNode);
      const seeds = myOnRoot.slice(0, 20).map(mr=> norm(mr));
      seeds.forEach(add);
      // 上へ
      for(const mr of seeds){
        let pid = mr.parent; let depth = 0;
        while(pid && pid !== String(rid) && depth < 8 && fetchBudget > 0){
          if(collected.has(pid)){ pid = collected.get(pid).parent; depth++; continue; }
          const node = await getNode(pid); if(!node) break;
          add(node); pid = node.parent; depth++;
        }
      }
      // 下へ
      let frontier = seeds.map(m=> m.id); let level = 0;
      while(frontier.length && level < 4 && fetchBudget > 0){
        const next = [];
        for(const id of frontier){
          if(fetchBudget <= 0) break;
          fetchBudget--;
          let rr; try{ rr = await j(`${BASE}/${id}/replies?fields=id,text,username,timestamp,replied_to{id}&limit=50&access_token=${t}`); }catch(e){ continue; }
          if(!rr || rr.error || !Array.isArray(rr.data)) continue;
          for(const c of rr.data){ const cm = norm(c, id); add(cm); next.push(cm.id); }
        }
        frontier = next; level++;
      }
      return buildConvs(Array.from(collected.values()), rid, rootAuthor, false, rootText, rootPermalink);
    }

    // --- 返信を root ごとに振り分け（自分の投稿 / 相手の投稿） ---
    const ownGroups = {}, otherGroups = {};
    const unresolved = []; // 振り分けできなかった返信（デバッグ用）
    for(const r of myReplies){
      const rid = await resolveRoot(r);
      if(!rid){ unresolved.push({ root: rootIdOf(r.root_post)||rootIdOf(r.replied_to)||null, text: (r.text||'').replace(/\n/g,' ').slice(0,30) }); continue; }
      if(myPosts.has(String(rid))) (ownGroups[rid] = ownGroups[rid] || []).push(r);
      else (otherGroups[rid] = otherGroups[rid] || []).push(r);
    }
    const selfPostReplyCount = Object.values(ownGroups).reduce((a,x)=> a+x.length, 0);
    const otherPostReplyCount = Object.values(otherGroups).reduce((a,x)=> a+x.length, 0);

    const conversations = [];
    const fallbacks = [];
    let failed = unresolved.length;

    // 自分の投稿：conversation 方式（軽い）
    for(const rid of Object.keys(ownGroups)){
      const meta = myPosts.get(String(rid)) || {};
      let conv = null, convOk = false;
      try{
        let cmsgs = [], curl = `${BASE}/${rid}/conversation?fields=id,username,text,timestamp,replied_to{id}&limit=100&access_token=${t}`, cp = 0, convErr = false;
        while(curl && cp < 3){
          const cd = await j(curl);
          if(cd.error){ convErr = true; break; }
          if(Array.isArray(cd.data)) cmsgs.push(...cd.data);
          curl = cd?.paging?.next || null; cp++;
        }
        if(!convErr){ conv = cmsgs; convOk = true; }
      }catch(e){ convOk = false; }
      if(!convOk){ fallbacks.push({ rootId: rid, rootText: meta.text||'', rootOwnerIsMe: true, myReplyCount: ownGroups[rid].length }); failed++; continue; }
      const items = conv.map(m=>({ id:String(m.id), username:m.username, text:m.text||'', ts:Date.parse(m.timestamp)||0, parent: m.replied_to ? String(rootIdOf(m.replied_to)) : null }));
      const convs = buildConvs(items, rid, myName, true, meta.text||'', meta.permalink||null);
      if(!convs.length){ fallbacks.push({ rootId: rid, rootText: meta.text||'', rootOwnerIsMe: true, myReplyCount: ownGroups[rid].length }); continue; }
      for(const c of convs){ c.pinIntro = hasPin(c.messages); conversations.push(c); }
    }

    // 相手の投稿：たどる方式（上限つき）
    for(const rid of Object.keys(otherGroups)){
      const myOnRoot = otherGroups[rid];
      const rootNode = await getNode(rid); // 相手の作者名・本文
      const rootAuthorName = rootNode ? rootNode.username : null;
      const rootText = rootNode ? rootNode.text : '';
      const convs = await walkOthersRoot(rid, myOnRoot, rootAuthorName, rootText, null);
      if(!convs.length){ fallbacks.push({ rootId: rid, rootText, rootOwnerIsMe: false, myReplyCount: myOnRoot.length }); continue; }
      for(const c of convs){ c.pinIntro = hasPin(c.messages); conversations.push(c); }
    }

    // 判定・集計
    const rally = conversations.filter(c=> c.round>=3);
    const almost = conversations.filter(c=> c.round===2);
    const ones  = conversations.filter(c=> c.round===1);
    const people = new Set(conversations.map(c=> c.otherName)).size;
    const pinIntroCount = conversations.filter(c=> c.pinIntro).length;

    return res.status(200).json({
      date, me: myName,
      replyCount: myReplies.length,
      selfPostReplyCount, otherPostReplyCount,
      peopleCount: people,
      rallyCount: rally.length, almostCount: almost.length, oneCount: ones.length,
      pinIntroCount,
      conversations, fallbacks,
      failed,
      debug: { fetchedReplies, unresolvedCount: unresolved.length, unresolved: unresolved.slice(0, 40) },
    });
  }catch(e){
    return res.status(500).json({ error: String(e.message || e) });
  }
}
