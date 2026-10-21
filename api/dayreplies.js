// 指定した日（日本時間 0:00〜23:59）に自分がした返信を集め、
// root_post（スレッドの元投稿）ごとに会話を組み立てて返す裏方。
// 自分の投稿への返信も、相手の投稿への返信も含む。
// ※他人の投稿は conversation が取れないことがあるので、その時は私の返信回数だけ数える。

const BASE = 'https://graph.threads.net/v1.0';
async function j(url){ const r = await fetch(url); return r.json(); }

// ISOタイムスタンプ → 日本時間の YYYY-MM-DD
function jstDateStr(ts){
  const d = new Date(ts);
  const g = new Date(d.getTime() + 9*3600*1000);
  return `${g.getUTCFullYear()}-${String(g.getUTCMonth()+1).padStart(2,'0')}-${String(g.getUTCDate()).padStart(2,'0')}`;
}
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

    // 自分の返信をページ送りで取得（新しい順。対象日より古くなったら打ち切り）
    let myReplies = [];
    let url = `${BASE}/me/replies?fields=id,text,timestamp,username,permalink,root_post{id},replied_to{id}&limit=100&access_token=${t}`;
    let pages = 0, stop = false;
    while(url && pages < 6 && !stop){
      const d = await j(url);
      if(d.error) throw new Error('返信一覧の取得エラー：' + JSON.stringify(d.error) + '（トークンに threads_read_replies が付いているか確認してください）');
      const arr = Array.isArray(d.data) ? d.data : [];
      for(const r of arr){
        const tms = Date.parse(r.timestamp);
        if(tms >= targetStart && tms < targetEnd) myReplies.push(r);
        if(tms < targetStart) stop = true; // これ以降は古い投稿しかない
      }
      url = (!stop && d?.paging?.next) ? d.paging.next : null;
      pages++;
    }

    // root_post ごとにまとめる
    const groups = {};
    for(const r of myReplies){
      const rid = rootIdOf(r.root_post);
      if(!rid) continue;
      (groups[rid] = groups[rid] || []).push(r);
    }
    const rootIds = Object.keys(groups);

    const MAX_ROOTS = 40;
    const useIds = rootIds.slice(0, MAX_ROOTS);
    let failed = Math.max(0, rootIds.length - useIds.length); // 件数上限で見れなかった分

    // ピン紹介（無料ガイド/ピン留め/ピン止め/URL）を自分の発言から判定
    const PIN_RE = /無料ガイド|ピン留め|ピン止め|ピンどめ|https?:\/\//;
    const hasPin = (messages)=> (messages||[]).some(m=> m.who==='me' && PIN_RE.test(m.text||''));

    // items（{id,username,text,ts,parent}）から、相手ごとに1対1の会話へ整理する共通処理
    function buildConvs(items, rid, rootAuthor, rootOwnerIsMe, rootText, rootPermalink){
      const authorById = {}; items.forEach(m=> authorById[String(m.id)]=m.username);
      const parentAuthor = (m)=>{
        if(!m.parent) return null;
        if(m.parent === String(rid)) return rootAuthor; // 元投稿への直返信（＝元投稿の作者宛て）
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
        if(myMsgs.length < 1 || uN < 1) continue; // やりとりが成立していない相手は除外
        // 往復数＝「相手→わたし」の組の数（自分の返信のうち相手宛ての数）
        let round = myMsgs.filter(m=> parentAuthor(m)===u).length;
        if(round < 1) round = Math.min(myMsgs.length, uN);
        const thread = exchange.slice().sort((a,b)=> a.ts-b.ts)
          .map(m=>({ who: m.username===myName ? 'me':'other', text: (m.text||'').slice(0,200) }));
        out.push({ rootId: rid, rootOwnerIsMe, rootText, rootPermalink, otherName: u, round, messages: thread });
      }
      return out;
    }

    // 相手の投稿：自分の返信を起点に、上（replied_to）と下（/replies）へたどって会話を組み立てる
    let fetchBudget = 150; // 追加探索で使えるAPI呼び出しの安全上限
    async function walkOthersRoot(rid, myOnRoot, rootAuthor, rootText, rootPermalink){
      const collected = new Map();
      const norm = (o, parentKnown)=>({ id:String(o.id), username:o.username||null, text:o.text||'', ts:Date.parse(o.timestamp)||0, parent: o.replied_to ? String(rootIdOf(o.replied_to)) : (parentKnown||null) });
      const add = (m)=>{ if(m && m.id && !collected.has(String(m.id))) collected.set(String(m.id), m); };
      const seeds = myOnRoot.slice(0, 15);
      // 上へ：相手の発言 → さらに上の自分 →…→ 元投稿 まで
      for(const mr of seeds){
        add(norm(mr));
        let pid = mr.replied_to ? String(rootIdOf(mr.replied_to)) : null;
        let depth = 0;
        while(pid && pid !== String(rid) && depth < 6 && fetchBudget > 0){
          if(collected.has(pid)){ pid = collected.get(pid).parent; depth++; continue; }
          fetchBudget--;
          let p; try{ p = await j(`${BASE}/${pid}?fields=id,text,username,timestamp,replied_to{id}&access_token=${t}`); }catch(e){ break; }
          if(!p || p.error) break;
          const pm = norm(p); add(pm);
          pid = pm.parent; depth++;
        }
      }
      // 下へ：自分の返信に相手がさらに返してくれた発言、その先の自分…
      let frontier = seeds.map(m=> String(m.id));
      let level = 0;
      while(frontier.length && level < 4 && fetchBudget > 0){
        const next = [];
        for(const id of frontier){
          if(fetchBudget <= 0) break;
          fetchBudget--;
          let rr; try{ rr = await j(`${BASE}/${id}/replies?fields=id,text,username,timestamp,replied_to{id}&limit=50&access_token=${t}`); }catch(e){ continue; }
          if(!rr || rr.error || !Array.isArray(rr.data)) continue;
          for(const c of rr.data){ add(norm(c, id)); next.push(String(c.id)); }
        }
        frontier = next; level++;
      }
      return buildConvs(Array.from(collected.values()), rid, rootAuthor, false, rootText, rootPermalink);
    }

    const conversations = []; // {rootId, rootOwnerIsMe, rootText, rootPermalink, otherName, round, messages, pinIntro}
    const fallbacks = [];     // {rootId, rootText, rootOwnerIsMe, myReplyCount}
    let selfPostReplyCount = 0, otherPostReplyCount = 0;

    for(const rid of useIds){
      const myOnRoot = groups[rid];
      // 元投稿のメタ（作者・冒頭）
      let rootOwnerIsMe = null, rootText = '', rootPermalink = null, rootAuthorName = null;
      try{
        const rp = await j(`${BASE}/${rid}?fields=id,username,text,permalink&access_token=${t}`);
        if(!rp.error){ rootOwnerIsMe = (myName && rp.username === myName); rootText = rp.text || ''; rootPermalink = rp.permalink || null; rootAuthorName = rp.username || null; }
      }catch(e){ /* 取れなくても続行 */ }

      // 返信数の内訳（自分の投稿 / 相手の投稿）
      if(rootOwnerIsMe === true) selfPostReplyCount += myOnRoot.length;
      else otherPostReplyCount += myOnRoot.length;

      let convsForRoot = [];
      if(rootOwnerIsMe === true){
        // 自分の投稿：conversation 方式（軽い）
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
        if(!convOk){ fallbacks.push({ rootId: rid, rootText, rootOwnerIsMe, myReplyCount: myOnRoot.length }); failed++; continue; }
        const items = conv.map(m=>({ id:String(m.id), username:m.username, text:m.text||'', ts:Date.parse(m.timestamp)||0, parent: m.replied_to ? String(rootIdOf(m.replied_to)) : null }));
        convsForRoot = buildConvs(items, rid, myName, true, rootText, rootPermalink);
      } else {
        // 相手の投稿：たどる方式（上限つき）
        if(fetchBudget <= 0){ failed++; fallbacks.push({ rootId: rid, rootText, rootOwnerIsMe, myReplyCount: myOnRoot.length }); continue; }
        convsForRoot = await walkOthersRoot(rid, myOnRoot, rootAuthorName, rootText, rootPermalink);
      }

      if(!convsForRoot.length){
        fallbacks.push({ rootId: rid, rootText, rootOwnerIsMe, myReplyCount: myOnRoot.length });
        continue;
      }
      for(const c of convsForRoot){ c.pinIntro = hasPin(c.messages); conversations.push(c); }
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
    });
  }catch(e){
    return res.status(500).json({ error: String(e.message || e) });
  }
}
