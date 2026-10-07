const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 25000 });
app.use(express.static(path.join(__dirname, "public")));

const categories = JSON.parse(fs.readFileSync(path.join(__dirname,"cards.json"),"utf8"));
const animeImageManifest = JSON.parse(fs.readFileSync(path.join(__dirname,"anime-images.json"),"utf8"));
const allCards = categories.flatMap(c=>c.cards);
const cardMap = new Map(allCards.map(c=>[c.id,c]));
const imageCache = new Map();
const imageBinaryCache = new Map();
const rooms = new Map();

const MODES = {
  "1v1": {label:"1v1", players:2, teams:2, teamSize:1},
  "1v1v1": {label:"1v1v1", players:3, teams:3, teamSize:1},
  "1v1v1v1": {label:"1v1v1v1", players:4, teams:4, teamSize:1},
  "2v2": {label:"2v2", players:4, teams:2, teamSize:2},
  "3v3": {label:"3v3", players:6, teams:2, teamSize:3},
};

const AUCTION_SECONDS = 10;
const BID_RESET_SECONDS = 10;
const BETWEEN_SECONDS = 3;

function sanitizeName(v){return String(v||"Player").trim().slice(0,18)||"Player";}
function code(){const a="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let s="";for(let i=0;i<5;i++)s+=a[Math.floor(Math.random()*a.length)];return s;}
function shuffle(a){a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function getRoom(socket){return rooms.get(socket.data.roomCode);}
function modeInfo(room){return MODES[room.settings.mode]||MODES["1v1"];}
function player(room,id){return room.players.find(p=>p.id===id);}
function clearTimers(room){if(room.auctionTimer)clearTimeout(room.auctionTimer);if(room.nextTimer)clearTimeout(room.nextTimer);}
function teamPublic(room,t){return {id:t.id,name:t.name,memberIds:t.memberIds};}
function publicCard(card){
 if(!card)return null;
 return {id:card.id,name:card.name,categoryId:card.categoryId,categoryName:card.categoryName,categoryIcon:card.categoryIcon,image:card.image||null,paid:card.paid};
}
function publicWinner(w){return w?{id:w.id,name:w.name,bid:w.bid,card:publicCard(w.card)}:null;}
function publicRoom(room){return {
 code:room.code,hostId:room.hostId,phase:room.phase,settings:room.settings,round:room.round,
 currentCard:publicCard(room.currentCard),auctionEndsAt:room.auctionEndsAt,highBid:room.highBid,highBidderId:room.highBidderId,
 passedIds:[...room.passed],lastWinner:publicWinner(room.lastWinner),teams:room.teams.map(t=>teamPublic(room,t)),judge:room.judge,
 players:room.players.map(p=>({id:p.id,name:p.name,cash:p.cash,inventory:p.inventory.map(publicCard),teamId:p.teamId}))
};}
function emitRoom(room){io.to(room.code).emit("room",publicRoom(room));}
function sound(room,type){io.to(room.code).emit("sound",type);}

function placeholder(label){const s=String(label||"?").replace(/[<>&'\"]/g,"").slice(0,28);const init=s.split(/\s+/).slice(0,2).map(x=>x[0]||"").join("").toUpperCase();return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="700" height="500"><defs><linearGradient id="g"><stop stop-color="#2b3043"/><stop offset="1" stop-color="#131720"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="350" cy="210" r="112" fill="#414860"/><text x="350" y="244" text-anchor="middle" font-family="Arial" font-weight="700" font-size="82" fill="white">${init}</text><text x="350" y="405" text-anchor="middle" font-family="Arial" font-size="29" fill="#d4d7e3">${s}</text></svg>`);}

function normalizeText(v){
 return String(v||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").trim();
}
function scoreName(candidate, wanted){
 const a=normalizeText(candidate), b=normalizeText(wanted);
 if(!a||!b)return 0;if(a===b)return 100;if(a.includes(b)||b.includes(a))return 82;
 const aa=new Set(a.split(" ")), bb=new Set(b.split(" "));let same=0;for(const x of aa)if(bb.has(x))same++;
 return Math.round((same/Math.max(aa.size,bb.size))*70);
}
async function jikanImage(query){
 try{
  const u=new URL("https://api.jikan.moe/v4/characters");u.searchParams.set("q",query);u.searchParams.set("limit","8");
  const r=await fetch(u,{headers:{"User-Agent":"ChooseEverything/3.1"},signal:AbortSignal.timeout(6000)});if(!r.ok)return null;
  const d=await r.json();const list=Array.isArray(d?.data)?d.data:[];
  list.sort((x,y)=>Math.max(scoreName(y?.name,query),...(y?.nicknames||[]).map(n=>scoreName(n,query)))-Math.max(scoreName(x?.name,query),...(x?.nicknames||[]).map(n=>scoreName(n,query))));
  const x=list[0];return x?.images?.webp?.large_image_url||x?.images?.jpg?.large_image_url||x?.images?.webp?.image_url||x?.images?.jpg?.image_url||null;
 }catch(e){return null;}
}
async function anilistImage(query){
 try{
  const gql=`query($search:String){Character(search:$search){name{full native alternative} image{large medium}}}`;
  const r=await fetch("https://graphql.anilist.co",{method:"POST",headers:{"Content-Type":"application/json","User-Agent":"ChooseEverything/3.1"},body:JSON.stringify({query:gql,variables:{search:query}}),signal:AbortSignal.timeout(6000)});
  if(!r.ok)return null;const d=await r.json();return d?.data?.Character?.image?.large||d?.data?.Character?.image?.medium||null;
 }catch(e){return null;}
}
async function kitsuImage(query){
 try{
  const u=new URL("https://kitsu.io/api/edge/characters");u.searchParams.set("filter[name]",query);u.searchParams.set("page[limit]","5");
  const r=await fetch(u,{headers:{"Accept":"application/vnd.api+json","User-Agent":"ChooseEverything/3.1"},signal:AbortSignal.timeout(6000)});if(!r.ok)return null;
  const d=await r.json();const arr=Array.isArray(d?.data)?d.data:[];arr.sort((a,b)=>scoreName(b?.attributes?.canonicalName,query)-scoreName(a?.attributes?.canonicalName,query));
  const im=arr[0]?.attributes?.image;return im?.original||im?.large||im?.medium||im?.small||null;
 }catch(e){return null;}
}
async function wikipediaImage(query){
 try{
  const u=new URL("https://en.wikipedia.org/w/api.php");u.searchParams.set("action","query");u.searchParams.set("generator","search");u.searchParams.set("gsrsearch",query);u.searchParams.set("gsrlimit","5");u.searchParams.set("prop","pageimages");u.searchParams.set("piprop","thumbnail");u.searchParams.set("pithumbsize","900");u.searchParams.set("format","json");u.searchParams.set("origin","*");
  const r=await fetch(u,{headers:{"User-Agent":"ChooseEverything/3.1"},signal:AbortSignal.timeout(6000)});if(!r.ok)return null;const d=await r.json();
  const pages=Object.values(d?.query?.pages||{});pages.sort((a,b)=>scoreName(b?.title,query)-scoreName(a?.title,query));return pages.find(x=>x?.thumbnail?.source)?.thumbnail?.source||null;
 }catch(e){return null;}
}
async function resolveImage(card){
 if(card.image) return card.image;
 const key=card.id;if(imageCache.has(key))return imageCache.get(key);
 let found=null;
 if(card.categoryId==="anime"){
  const m=animeImageManifest[card.id]||{};const canonical=m.canonical||card.imageQuery||card.query||card.name;const wiki=m.wiki||card.wikiQuery||card.name;
  found=await jikanImage(canonical);
  if(!found)found=await anilistImage(canonical);
  if(!found)found=await kitsuImage(canonical);
  if(!found)found=await wikipediaImage(wiki);
 }else{
  found=await wikipediaImage(card.query||card.name);
 }
 imageCache.set(key,found||"");return found;
}
async function imagePayload(card){
 const key=card.id;
 if(imageBinaryCache.has(key))return imageBinaryCache.get(key);
 const u=await resolveImage(card);
 if(u){
  if(u.startsWith("/")){
   try{const p=path.join(__dirname,"public",u.replace(/^\/+/,""));const buf=await fs.promises.readFile(p);const ext=path.extname(p).toLowerCase();const contentType=ext===".png"?"image/png":ext===".webp"?"image/webp":"image/jpeg";const payload={contentType,buffer:buf};imageBinaryCache.set(key,payload);return payload;}catch(e){}
  }
  try{
   const r=await fetch(u,{headers:{"User-Agent":"Mozilla/5.0 ChooseEverything/3.2","Accept":"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"},signal:AbortSignal.timeout(8000)});
   if(r.ok){const contentType=r.headers.get("content-type")||"image/jpeg";const buffer=Buffer.from(await r.arrayBuffer());if(buffer.length>0){const payload={contentType,buffer};imageBinaryCache.set(key,payload);return payload;}}
  }catch(e){}
 }
 const payload={contentType:"image/svg+xml",buffer:placeholder(card.name)};imageBinaryCache.set(key,payload);return payload;
}
async function prewarmCardImage(card){if(!card)return;try{await imagePayload(card);}catch(e){}}
app.get("/api/card-image/:id",async(req,res)=>{
 const c=cardMap.get(req.params.id);if(!c)return res.status(404).end();
 res.set("Cache-Control","public, max-age=604800, immutable");
 const payload=await imagePayload(c);
 res.type(payload.contentType).send(payload.buffer);
});
app.get("/api/catalog",(req,res)=>res.json(categories.map(c=>({id:c.id,name:c.name,icon:c.icon,count:c.cards.length}))));
app.get("/api/health",(req,res)=>res.json({ok:true,cards:allCards.length,categories:categories.length,animeImageMappings:Object.keys(animeImageManifest).length,ai:Boolean(process.env.OPENAI_API_KEY)}));

function assignTeams(room){
 const m=modeInfo(room);const ids=shuffle(room.players.map(p=>p.id));room.teams=[];
 if(m.teamSize===1){ids.forEach((id,i)=>room.teams.push({id:`T${i+1}`,name:`Time ${i+1}`,memberIds:[id]}));}
 else{for(let i=0;i<m.teams;i++)room.teams.push({id:`T${i+1}`,name:`Time ${i+1}`,memberIds:ids.slice(i*m.teamSize,(i+1)*m.teamSize)});}
 for(const t of room.teams)for(const id of t.memberIds){const p=player(room,id);if(p)p.teamId=t.id;}
}
function buildDeck(room){let pool;if(room.settings.categoryId==="mixed")pool=allCards;else pool=(categories.find(c=>c.id===room.settings.categoryId)?.cards||allCards);return shuffle(pool);}
function activeForAuction(room,p){return !room.passed.has(p.id);}
function everyoneDone(room){
 const bidder=room.highBidderId;
 return room.players.every(p=>room.passed.has(p.id)||p.id===bidder);
}
async function beginAuction(room){
 if(room.round>=room.settings.rounds||room.deckIndex>=room.deck.length){return beginJudging(room);}
 room.phase="loadingCard";room.currentCard=room.deck[room.deckIndex++];room.highBid=0;room.highBidderId=null;room.lastWinner=null;room.passed=new Set();room.auctionEndsAt=null;emitRoom(room);
 await prewarmCardImage(room.currentCard);
 if(room.phase!=="loadingCard")return;
 room.phase="auction";room.round++;room.auctionEndsAt=Date.now()+AUCTION_SECONDS*1000;emitRoom(room);sound(room,"round");scheduleEnd(room);
 // Enquanto a rodada atual acontece, prepara a próxima foto em segundo plano.
 prewarmCardImage(room.deck[room.deckIndex]);
}
function resetAuctionClock(room){room.auctionEndsAt=Date.now()+BID_RESET_SECONDS*1000;scheduleEnd(room);}
function scheduleEnd(room){if(room.auctionTimer)clearTimeout(room.auctionTimer);room.auctionTimer=setTimeout(()=>finishAuction(room),Math.max(50,room.auctionEndsAt-Date.now()));}
function finishAuction(room){
 if(room.phase!=="auction")return;const w=player(room,room.highBidderId);if(w&&room.highBid>0){w.cash-=room.highBid;w.inventory.push({...room.currentCard,paid:room.highBid});room.lastWinner={id:w.id,name:w.name,bid:room.highBid,card:room.currentCard};}else room.lastWinner={id:null,name:"Ninguém",bid:0,card:room.currentCard};
 room.phase="between";room.auctionEndsAt=null;emitRoom(room);sound(room,w?"win":"miss");room.nextTimer=setTimeout(()=>beginAuction(room),BETWEEN_SECONDS*1000);
}
function teamRoster(room,t){return t.memberIds.flatMap(id=>{const p=player(room,id);return (p?.inventory||[]).map(c=>({owner:p.name,name:c.name,score:c.score,category:c.categoryName,paid:c.paid}));});}
function localJudge(room){
 const scored=room.teams.map(t=>{const r=teamRoster(room,t);const base=r.reduce((s,c)=>s+c.score,0);const depth=Math.min(25,r.length*2);const diversity=new Set(r.map(c=>c.category)).size*2;return {t,score:base+depth+diversity,roster:r};}).sort((a,b)=>b.score-a.score);
 const w=scored[0];return {source:"local",winnerTeamId:w?.t.id||null,confidence:0.55,summary:w?`${w.t.name} leva vantagem pelo conjunto geral da coleção.`:"Sem vencedor.",reasons:w?[`O juiz local considera força relativa, quantidade e variedade das cartas sem revelar valores internos.`,`Quantidade de cartas do time: ${w.roster.length}.`,`Ative a IA OpenAI para uma análise canônica mais detalhada.`]:[]};
}
async function aiJudge(room){
 const fallback=localJudge(room);if(!process.env.OPENAI_API_KEY)return fallback;
 try{
  const OpenAI=require("openai");const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
  const teams=room.teams.map(t=>({id:t.id,name:t.name,members:t.memberIds.map(id=>player(room,id)?.name),roster:teamRoster(room,t).map(c=>({owner:c.owner,name:c.name,category:c.category,paid:c.paid}))}));
  const prompt=`Você é o juiz final de um jogo de confrontos. Responda APENAS JSON válido. Modo: ${room.settings.mode}. Categoria do leilão: ${room.settings.categoryId}. Compare os times usando feitos canônicos e habilidades conhecidas. Respeite exatamente a forma/transformação escrita no nome da carta (por exemplo: Ultra Instinct, Gear 5, GER, Tusk Act 4, Founding Titan). Para personagens de ficção, use versões padrão/mais reconhecidas, não fanfic. Considere velocidade, força, resistência, hax, inteligência, sinergia e counters. Para categorias não-combate (comida, carros, futebol, tecnologia), interprete "vencer" como melhor conjunto geral para a categoria. Times: ${JSON.stringify(teams)}. Formato: {"winnerTeamId":"T1","confidence":0.0,"summary":"...","reasons":["...","...","..."]}`;
  const resp=await client.responses.create({model:process.env.OPENAI_MODEL||"gpt-5.6",input:prompt});
  const txt=resp.output_text||"";const a=txt.indexOf("{");const b=txt.lastIndexOf("}");if(a<0||b<a)throw new Error("no json");const out=JSON.parse(txt.slice(a,b+1));
  if(!room.teams.some(t=>t.id===out.winnerTeamId))throw new Error("bad team");return {source:"openai",winnerTeamId:out.winnerTeamId,confidence:Number(out.confidence)||0.7,summary:String(out.summary||""),reasons:Array.isArray(out.reasons)?out.reasons.slice(0,5):[]};
 }catch(e){return {...fallback,summary:fallback.summary+" A IA externa falhou nesta rodada, então usei o juiz local."};}
}
async function beginJudging(room){room.phase="judging";room.currentCard=null;room.judge=null;emitRoom(room);sound(room,"judge");const result=await aiJudge(room);if(room.phase!=="judging")return;room.judge=result;room.phase="results";emitRoom(room);sound(room,"final");}

io.on("connection",socket=>{
 socket.emit("catalog",categories.map(c=>({id:c.id,name:c.name,icon:c.icon,count:c.cards.length})));
 socket.on("createRoom",({name},cb)=>{let c;do{c=code();}while(rooms.has(c));const room={code:c,hostId:socket.id,phase:"lobby",settings:{categoryId:"anime",rounds:12,startingCash:100,mode:"1v1"},round:0,players:[{id:socket.id,name:sanitizeName(name),cash:100,inventory:[],teamId:null}],teams:[],deck:[],deckIndex:0,currentCard:null,highBid:0,highBidderId:null,passed:new Set(),lastWinner:null,judge:null};rooms.set(c,room);socket.join(c);socket.data.roomCode=c;cb?.({ok:true,code:c});emitRoom(room);});
 socket.on("joinRoom",({name,code:raw},cb)=>{const c=String(raw||"").toUpperCase().trim(),room=rooms.get(c);if(!room)return cb?.({ok:false,error:"Sala não encontrada."});if(room.phase!=="lobby")return cb?.({ok:false,error:"A partida já começou."});if(room.players.length>=6)return cb?.({ok:false,error:"Sala cheia (máximo 6)."});room.players.push({id:socket.id,name:sanitizeName(name),cash:room.settings.startingCash,inventory:[],teamId:null});socket.join(c);socket.data.roomCode=c;cb?.({ok:true,code:c});emitRoom(room);});
 socket.on("settings",data=>{const room=getRoom(socket);if(!room||room.hostId!==socket.id||room.phase!=="lobby")return;const m=MODES[data?.mode]?data.mode:room.settings.mode;const cat=(data?.categoryId==="mixed"||categories.some(c=>c.id===data?.categoryId))?data.categoryId:room.settings.categoryId;const rounds=Math.floor(Number(data?.rounds));const startingCash=Math.floor(Number(data?.startingCash));room.settings={mode:m,categoryId:cat,rounds:Number.isFinite(rounds)?Math.max(1,Math.min(500,rounds)):12,startingCash:Number.isFinite(startingCash)?Math.max(1,Math.min(1000000000,startingCash)):100};room.players.forEach(p=>p.cash=room.settings.startingCash);emitRoom(room);});
 socket.on("startGame",()=>{const room=getRoom(socket);if(!room||room.hostId!==socket.id||room.phase!=="lobby")return;const need=modeInfo(room).players;if(room.players.length!==need)return socket.emit("toast",`O modo ${room.settings.mode} precisa de exatamente ${need} jogadores. Agora há ${room.players.length}.`);clearTimers(room);assignTeams(room);room.players.forEach(p=>{p.cash=room.settings.startingCash;p.inventory=[];});room.deck=buildDeck(room);room.deckIndex=0;room.round=0;room.judge=null;beginAuction(room);});
 socket.on("bid",({amount})=>{const room=getRoom(socket);if(!room||room.phase!=="auction")return;const p=player(room,socket.id);if(!p||room.passed.has(p.id))return socket.emit("toast","Você passou este item.");amount=Math.floor(Number(amount));if(!Number.isFinite(amount))return;const min=room.highBid+1;if(amount<min)return socket.emit("toast",`Lance mínimo: ${min}.`);if(amount>p.cash)return socket.emit("toast","Moedas insuficientes.");room.highBid=amount;room.highBidderId=p.id;resetAuctionClock(room);emitRoom(room);sound(room,"bid");if(everyoneDone(room)){clearTimeout(room.auctionTimer);setTimeout(()=>finishAuction(room),500);}});
 socket.on("cover",()=>{const room=getRoom(socket);if(!room||room.phase!=="auction")return;const p=player(room,socket.id);if(!p||room.passed.has(p.id))return;if(room.highBidderId===p.id)return socket.emit("toast","Você já tem o maior lance.");const amount=room.highBid+1;if(amount>p.cash)return socket.emit("toast","Você não tem moedas para cobrir.");room.highBid=amount;room.highBidderId=p.id;resetAuctionClock(room);emitRoom(room);sound(room,"bid");if(everyoneDone(room)){clearTimeout(room.auctionTimer);setTimeout(()=>finishAuction(room),500);}});
 socket.on("pass",()=>{const room=getRoom(socket);if(!room||room.phase!=="auction")return;if(room.highBidderId===socket.id)return socket.emit("toast","Você está com o maior lance e não pode retirar esse lance.");room.passed.add(socket.id);emitRoom(room);sound(room,"pass");if(everyoneDone(room)){clearTimeout(room.auctionTimer);setTimeout(()=>finishAuction(room),500);}});
 socket.on("backToLobby",()=>{const room=getRoom(socket);if(!room||room.hostId!==socket.id||room.phase!=="results")return;clearTimers(room);room.phase="lobby";room.round=0;room.currentCard=null;room.judge=null;room.teams=[];room.players.forEach(p=>{p.cash=room.settings.startingCash;p.inventory=[];p.teamId=null;});emitRoom(room);});
 socket.on("disconnect",()=>{const room=getRoom(socket);if(!room)return;room.passed.delete(socket.id);room.players=room.players.filter(p=>p.id!==socket.id);if(!room.players.length){clearTimers(room);rooms.delete(room.code);return;}if(room.hostId===socket.id)room.hostId=room.players[0].id;if(room.highBidderId===socket.id){room.highBid=0;room.highBidderId=null;}emitRoom(room);});
});

const PORT=process.env.PORT||3000;server.listen(PORT,()=>console.log(`Choose Everything V3 em http://localhost:${PORT} | ${allCards.length} cartas`));
