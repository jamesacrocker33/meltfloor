// ============================================================
// MELTFLOOR v3 — AI eBay Listing Generator for Coins, PM & Jewelry
// Single-file Cloudflare Worker (UI + API + metering)
//
// SETUP (one time, in Cloudflare dashboard > Settings > Variables & Secrets):
//   ANTHROPIC_API_KEY  (secret)      — your Anthropic API key
//   ACCESS_CODES       (plain text)  — comma-separated customer codes,
//                                      e.g.  GOLD-2481, SILV-7739
//   To add a paying customer: append a new code to ACCESS_CODES, save.
//   To cancel one: delete it from the list, save.
//   Then edit the two constants below and Deploy.
// ============================================================

const PAYMENT_LINK = "https://buy.stripe.com/REPLACE_ME"; // your Stripe Payment Link
const SUPPORT_EMAIL = "jamesacrocker@gmail.com";                    // where buyers reach you
const FREE_LIMIT = 5;                                      // free listings per visitor
const BRAND = "MeltFloor";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/") return html(PAGE_APP);
      if (p === "/spot") return getSpot();
      if (p === "/quota") return getQuota(request, env);
      if (p === "/generate") {
        if (request.method === "POST") return generate(await request.json(), env);
        const q = url.searchParams.get("q");
        if (q) return generate(JSON.parse(decodeURIComponent(escape(atob(q)))), env);
        return json({ error: "Bad generate request." }, 400);
      }
      if (p === "/selftest") return selftest(env);
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: "Server error: " + e.message }, 500);
    }
  },
};

// ---------- helpers ----------
const html = (s) =>
  new Response(s, { headers: { "content-type": "text/html;charset=utf-8" } });
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------- spot prices ----------
async function getSpot() {
  const [au, ag] = await Promise.all([
    fetch("https://api.gold-api.com/price/XAU").then((r) => r.json()),
    fetch("https://api.gold-api.com/price/XAG").then((r) => r.json()),
  ]);
  return json({ gold: au.price, silver: ag.price, ts: Date.now() });
}

// ---------- quota / access (no-KV version) ----------
// Paid codes live in an env variable ACCESS_CODES: comma-separated,
// e.g.  GOLD-2481, SILV-7739
// Add/remove codes in Cloudflare: Settings > Variables & Secrets.
// Free quota is tracked in the visitor's browser (localStorage).
function validCode(env, code) {
  if (!code || !env.ACCESS_CODES) return false;
  return env.ACCESS_CODES.split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean)
    .includes(code.trim().toUpperCase());
}

function checkAccess(env, used, code) {
  if (code) {
    if (validCode(env, code)) return { ok: true, paid: true };
    return { ok: false, reason: "Access code not found or deactivated." };
  }
  if ((parseInt(used) || 0) >= FREE_LIMIT)
    return { ok: false, reason: "Free limit reached.", upgrade: true };
  return { ok: true, paid: false };
}

async function getQuota(request, env) {
  const u = new URL(request.url);
  const code = u.searchParams.get("code") || "";
  if (code) return json({ paid: validCode(env, code) });
  return json({ paid: false, limit: FREE_LIMIT });
}

// ---------- generation ----------
const CATEGORY_PROMPTS = {
  coins: `You are an expert numismatist writing eBay listings. Use correct numismatic terminology (mint marks, varieties, strike quality, surfaces, luster). Be conservative on grade language for raw coins — describe, never assign a certified grade unless the coin is slabbed (then lead the title with grader + grade). Mention key diagnostics honestly, including problems (cleaning, rim damage, spots).`,
  metals: `You are a precious metals specialist writing eBay listings for bullion, scrap, and melt-value lots. Lead with metal, purity, and total weight. State actual weight prominently. Never overstate purity. If the seller supplied a melt value, the listing price guidance must NEVER go below it.`,
  jewelry: `You are an estate jewelry specialist writing eBay listings. Identify metal and hallmarks precisely, describe stones conservatively (say "tests as" or "appears to be" for unverified stones), note construction era clues, measurements, and gram weight. Flag repairs or wear honestly.`,
  watches: `You are a vintage watch specialist writing eBay listings. Identify movement, caliber if visible, case material and size, dial condition, and service history status. State clearly whether the watch is running, and never guarantee timekeeping on vintage pieces.`,
  collectibles: `You are a collectibles specialist writing eBay listings. Identify maker, era, and market-relevant details. Describe condition honestly using category-standard terms.`,
};

async function generate(body, env) {
  const { category, fields, photos, melt, used, code } = body;

  const access = checkAccess(env, used, code);
  if (!access.ok) return json({ error: access.reason, upgrade: !!access.upgrade }, 402);

  const sys =
    (CATEGORY_PROMPTS[category] || CATEGORY_PROMPTS.collectibles) +
    `
Respond with ONLY a JSON object, no markdown fences, no preamble, with exactly these keys:
{"title": "max 80 chars, keyword-front-loaded",
 "description": "plain text with paragraph breaks, honest and detailed, buyer-facing",
 "condition": "one line",
 "item_specifics": {"key": "value", ...},
 "price": {"suggested_list": number, "floor": number, "reasoning": "one line"},
 "keywords": ["search terms buyers actually type"]}` +
    (melt && melt > 0
      ? `\nMELT FLOOR: intrinsic metal value is $${melt.toFixed(2)}. price.floor MUST be >= this. Never suggest listing below melt.`
      : "") +
    (access.paid ? "" : `\nEnd the description with the line: "Listing generated with ${BRAND}."`);

  const content = [];
  for (const ph of (photos || []).slice(0, 4)) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: ph.type, data: ph.data },
    });
  }
  content.push({
    type: "text",
    text:
      `Create an eBay listing. Category: ${category}\n` +
      Object.entries(fields || {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n") +
      (melt ? `\nCalculated melt value: $${melt.toFixed(2)}` : "") +
      (photos && photos.length ? `\nAnalyze the attached photos for details the seller didn't type.` : ""),
  });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    }),
  });
  const raw = await resp.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { return json({ error: "AI gateway returned status " + resp.status + ": " + raw.slice(0, 200) }, 502); }
  if (data.error) return json({ error: "AI error: " + (data.error.message || JSON.stringify(data.error)) }, 502);

  let listing;
  try {
    listing = JSON.parse(
      data.content.filter((c) => c.type === "text").map((c) => c.text).join("")
        .replace(/```json|```/g, "").trim()
    );
  } catch {
    return json({ error: "AI returned unparseable output — try again." }, 502);
  }

  return json({ listing, paid: access.paid });
}

// ---------- selftest (open /selftest in a browser) ----------
async function selftest(env) {
  const lines = [];
  lines.push("MELTFLOOR SELF-TEST");
  lines.push("ANTHROPIC_API_KEY present: " + (env.ANTHROPIC_API_KEY ? "YES" : "NO - add it in Settings"));
  lines.push("ACCESS_CODES present: " + (env.ACCESS_CODES ? "YES (" + env.ACCESS_CODES + ")" : "NO"));
  if (env.ANTHROPIC_API_KEY) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 30,
          messages: [{ role: "user", content: "Reply with exactly: SELFTEST OK" }],
        }),
      });
      const t = await r.text();
      lines.push("Anthropic API status: " + r.status);
      lines.push("Anthropic API reply: " + t.slice(0, 300));
    } catch (e) {
      lines.push("Anthropic API call threw: " + e.message);
    }
  }
  return new Response(lines.join("\n\n"), { headers: { "content-type": "text/plain" } });
}

// ============================================================
// FRONTEND — app page
// ============================================================
const CSS = `
:root{--bg:#0C0E10;--panel:#14171B;--panel2:#1A1E23;--line:#262B31;
--txt:#C9CFD6;--dim:#7A828C;--au:#E8A33D;--ag:#B9C2CC;--ok:#58B368;--bad:#E05555;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--txt);font-family:var(--sans);font-size:15px;line-height:1.5}
.wrap{max-width:760px;margin:0 auto;padding:0 14px 60px}
/* signature: DRO ticker */
.dro{position:sticky;top:0;z-index:9;background:linear-gradient(180deg,#101215,#0C0E10);
border-bottom:1px solid var(--line);padding:10px 14px;display:flex;gap:18px;align-items:baseline;
font-family:var(--mono);font-size:13px;overflow-x:auto;white-space:nowrap}
.dro b{font-size:11px;letter-spacing:.12em;color:var(--dim);font-weight:600}
.dro .au{color:var(--au)} .dro .ag{color:var(--ag)}
.dro .melt{color:var(--ok);margin-left:auto}
h1{font-family:var(--mono);font-size:19px;letter-spacing:.06em;margin:22px 0 2px;color:#fff}
h1 span{color:var(--au)}
.sub{color:var(--dim);font-size:13px;margin-bottom:18px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.tab{background:var(--panel);border:1px solid var(--line);color:var(--dim);padding:8px 13px;
border-radius:6px;font-family:var(--mono);font-size:12px;letter-spacing:.05em;cursor:pointer}
.tab.on{color:var(--au);border-color:var(--au);background:var(--panel2)}
label{display:block;font-family:var(--mono);font-size:11px;letter-spacing:.1em;
color:var(--dim);margin:14px 0 5px;text-transform:uppercase}
input,textarea,select{width:100%;background:var(--panel);border:1px solid var(--line);
color:var(--txt);padding:11px 12px;border-radius:6px;font-size:15px;font-family:var(--sans)}
input:focus,textarea:focus{outline:2px solid var(--au);outline-offset:-1px;border-color:transparent}
.row{display:flex;gap:10px}.row>div{flex:1}
.count{font-family:var(--mono);font-size:11px;color:var(--dim);text-align:right;margin-top:4px}
.count.over{color:var(--bad)}
.photos{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.photos img{width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid var(--line)}
button.go{width:100%;margin-top:22px;background:var(--au);color:#161006;border:0;padding:15px;
border-radius:8px;font-size:16px;font-weight:700;cursor:pointer;font-family:var(--mono);letter-spacing:.04em}
button.go:disabled{opacity:.5}
button.ghost{background:var(--panel);color:var(--txt);border:1px solid var(--line);padding:9px 14px;
border-radius:6px;font-size:13px;cursor:pointer}
.quota{font-family:var(--mono);font-size:12px;color:var(--dim);text-align:center;margin-top:10px}
.quota b{color:var(--au)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:18px}
.card h3{font-family:var(--mono);font-size:11px;letter-spacing:.12em;color:var(--dim);
text-transform:uppercase;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
.copy{background:none;border:1px solid var(--line);color:var(--au);font-family:var(--mono);
font-size:11px;padding:4px 9px;border-radius:5px;cursor:pointer}
.val{white-space:pre-wrap;word-break:break-word}
.price{font-family:var(--mono);font-size:20px;color:var(--ok)}
.floor{font-family:var(--mono);font-size:12px;color:var(--dim);margin-top:4px}
.err{background:#2A1416;border:1px solid var(--bad);color:#F0A8A8;padding:12px;border-radius:8px;margin-top:16px}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;
justify-content:center;padding:20px;z-index:20}
.modal .box{background:var(--panel2);border:1px solid var(--au);border-radius:12px;padding:24px;max-width:400px}
.modal h2{font-family:var(--mono);color:var(--au);font-size:16px;margin-bottom:10px}
.modal p{font-size:14px;color:var(--txt);margin-bottom:14px}
.modal a.pay{display:block;text-align:center;background:var(--au);color:#161006;font-weight:700;
padding:13px;border-radius:8px;text-decoration:none;margin-bottom:12px}
.hist{margin-top:26px}
.hist .item{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;
margin-top:8px;font-size:13px;cursor:pointer;display:flex;justify-content:space-between;gap:10px}
.hist .item span{color:var(--dim);font-family:var(--mono);font-size:11px;flex-shrink:0}
footer{margin-top:40px;font-family:var(--mono);font-size:11px;color:var(--dim);text-align:center}
footer a{color:var(--dim)}
@media(prefers-reduced-motion:no-preference){.card{animation:up .25s ease}
@keyframes up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}}
`;

const CATEGORY_FIELDS = {
  coins: [
    ["item", "Coin (year, denomination, mint)"],
    ["grade", "Grade / certification (if slabbed)"],
    ["notes", "Condition notes, varieties, problems"],
  ],
  metals: [
    ["item", "Item (bar, round, scrap lot...)"],
    ["notes", "Marks, source, condition"],
  ],
  jewelry: [
    ["item", "Piece (ring, pendant, brooch...)"],
    ["marks", "Hallmarks / maker marks"],
    ["stones", "Stones (type, size, tested?)"],
    ["notes", "Era, condition, repairs, measurements"],
  ],
  watches: [
    ["item", "Watch (brand, model, year)"],
    ["movement", "Movement / caliber / running?"],
    ["notes", "Case, dial, band, service history"],
  ],
  collectibles: [
    ["item", "Item"],
    ["notes", "Maker, era, condition, provenance"],
  ],
};

const PAGE_APP = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BRAND} — AI eBay listings that never price below melt</title>
<style>${CSS}</style></head><body>
<div class="dro" id="dro">
  <b>SPOT</b><span class="au">AU —</span><span class="ag">AG —</span>
  <span class="melt" id="droMelt"></span>
</div>
<div class="wrap">
<h1>MELT<span>FLOOR</span></h1>
<p class="sub">AI eBay listings for coins, precious metals &amp; estate jewelry — priced against live melt value, never below it.</p>

<div class="tabs" id="tabs"></div>
<div id="form"></div>

<label>Metal content (optional — sets the melt floor)</label>
<div class="row">
  <div><select id="metal"><option value="">No metal / skip</option>
    <option value="gold">Gold</option><option value="silver">Silver</option></select></div>
  <div><input id="weight" inputmode="decimal" placeholder="Weight"></div>
  <div><select id="unit"><option value="g">grams</option><option value="ozt">troy oz</option></select></div>
</div>
<div class="row" style="margin-top:10px">
  <div><select id="purity">
    <option value="">Purity…</option>
    <option value=".999">.999 fine</option><option value=".925">Sterling .925</option>
    <option value=".900">Coin .900</option><option value=".750">18K (.750)</option>
    <option value=".585">14K (.585)</option><option value=".417">10K (.417)</option>
  </select></div>
  <div style="display:flex;align-items:center"><span class="floor" id="meltOut">Melt: —</span></div>
</div>

<label>Photos (up to 4 — AI reads details from them)</label>
<input type="file" id="photoIn" accept="image/*" multiple>
<div class="photos" id="photoPrev"></div>

<button class="go" id="go">GENERATE LISTING</button>
<div class="quota" id="quota"></div>
<div id="out"></div>

<div class="hist" id="hist"></div>
<footer>${BRAND} · <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> ·
<a href="#" id="codeLink">enter access code</a></footer>
</div>

<div class="modal" id="modal" style="display:none"><div class="box">
<h2>You've used your ${FREE_LIMIT} free listings</h2>
<p>Unlimited listings, no watermark line, priority support — <b>$15/month</b>.</p>
<a class="pay" href="${PAYMENT_LINK}" target="_blank" rel="noopener">Subscribe — $15/mo</a>
<p style="font-size:12px;color:var(--dim)">After checkout you'll get an access code by email within a few hours. Have one already?</p>
<input id="codeIn" placeholder="ACCESS-CODE" style="text-transform:uppercase">
<div class="row" style="margin-top:10px">
<button class="ghost" id="codeSave" style="flex:1">Activate code</button>
<button class="ghost" id="modalClose" style="flex:1">Close</button></div>
</div></div>

<script>
const FIELDS=${JSON.stringify(CATEGORY_FIELDS)};
const $=(id)=>document.getElementById(id);
let cat="coins", photos=[], spot={gold:0,silver:0};
let used=parseInt(localStorage.mf_used||"0");
let code=localStorage.mf_code||"";

// tabs
const tabs=$("tabs");
Object.keys(FIELDS).forEach(k=>{
  const b=document.createElement("button");b.className="tab"+(k===cat?" on":"");
  b.textContent=k.toUpperCase();b.onclick=()=>{cat=k;
    [...tabs.children].forEach(t=>t.classList.remove("on"));b.classList.add("on");renderForm();};
  tabs.appendChild(b);});
function renderForm(){
  $("form").innerHTML=FIELDS[cat].map(([n,l])=>
    '<label>'+l+'</label>'+
    (n==="notes"?'<textarea id="f_'+n+'" rows="3"></textarea>'
      :'<input id="f_'+n+'"'+(n==="item"?' maxlength="200"':'')+'>')
  ).join("");
}
renderForm();

// spot + melt
fetch("/spot").then(r=>r.json()).then(s=>{spot=s;
  $("dro").innerHTML='<b>SPOT</b><span class="au">AU $'+s.gold.toFixed(2)+
  '</span><span class="ag">AG $'+s.silver.toFixed(2)+'</span><span class="melt" id="droMelt"></span>';
  calcMelt();}).catch(()=>{});
["metal","weight","unit","purity"].forEach(id=>$(id).addEventListener("input",calcMelt));
function melt(){
  const m=$("metal").value,w=parseFloat($("weight").value)||0,
  pu=parseFloat($("purity").value)||0;
  if(!m||!w||!pu)return 0;
  const ozt=$("unit").value==="g"?w/31.1035:w;
  return ozt*pu*(m==="gold"?spot.gold:spot.silver);}
function calcMelt(){const v=melt();
  $("meltOut").textContent="Melt: "+(v?"$"+v.toFixed(2):"—");
  const d=$("droMelt");if(d)d.textContent=v?"FLOOR $"+v.toFixed(2):"";}

// photos
$("photoIn").addEventListener("change",async e=>{
  photos=[];$("photoPrev").innerHTML="";
  for(const f of [...e.target.files].slice(0,4)){
    const data=await new Promise(res=>{const r=new FileReader();
      r.onload=()=>res(r.result.split(",")[1]);r.readAsDataURL(f);});
    photos.push({type:f.type,data});
    const img=document.createElement("img");
    img.src="data:"+f.type+";base64,"+data;$("photoPrev").appendChild(img);}});

// quota display
const LIMIT=${FREE_LIMIT};
function showQuota(){
  $("quota").innerHTML=code?'<b>PRO</b> · unlimited'
    :'<b>'+Math.max(0,LIMIT-used)+'</b> of '+LIMIT+' free listings left';}
showQuota();

// generate
$("go").onclick=async()=>{
  const fields={};FIELDS[cat].forEach(([n])=>fields[n]=($("f_"+n)||{}).value||"");
  if(!fields.item){alert("Describe the item first.");return;}
  $("go").disabled=true;$("go").textContent="WORKING…";$("out").innerHTML="";
  try{
    const payload={category:cat,fields,photos,melt:melt(),used,code};
    let r,raw,d;
    try{
      r=await fetch("/generate",{method:"POST",
        headers:{"content-type":"text/plain"},
        body:JSON.stringify(payload)});
      raw=await r.text();
    }catch(_){raw=null;}
    if(raw!=null){try{d=JSON.parse(raw);}catch(_){d=null;}}
    if(!d){
      if(photos.length)throw new Error("POST blocked on this network and photos are too large for the fallback path — retry without photos or on another network. Server said ("+(r?r.status:"no response")+"): "+String(raw||"").slice(0,120));
      const b64=btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
      r=await fetch("/generate?q="+encodeURIComponent(b64));
      raw=await r.text();
      try{d=JSON.parse(raw);}catch(_){throw new Error("Server said ("+r.status+"): "+String(raw).slice(0,150));}
    }
    if(d.error){
      if(d.upgrade)$("modal").style.display="flex";
      else $("out").innerHTML='<div class="err">'+d.error+'</div>';
      return;}
    render(d.listing);
    if(!code){used++;localStorage.mf_used=used;}
    showQuota();
    saveHist(d.listing);
  }catch(e){$("out").innerHTML='<div class="err">Error: '+esc(e.message||e)+' — screenshot this and send it to support.</div>';}
  finally{$("go").disabled=false;$("go").textContent="GENERATE LISTING";}};

function card(title,val,pre){
  return '<div class="card"><h3>'+title+
  '<button class="copy" onclick="cp(this)">COPY</button></h3>'+
  '<div class="val">'+(pre||"")+esc(val)+'</div></div>';}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;");}
window.cp=(btn)=>{const t=btn.closest(".card").querySelector(".val").innerText;
  navigator.clipboard.writeText(t).then(()=>{btn.textContent="COPIED";
  setTimeout(()=>btn.textContent="COPY",1500);});};

function money(v){const n=parseFloat(String(v==null?"":v).replace(/[^0-9.\-]/g,""));
  return isNaN(n)?String(v||"—"):"$"+n.toFixed(2);}
function render(L){
  L=L||{};const P=L.price||{};
  const specs=Object.entries(L.item_specifics||{}).map(([k,v])=>k+": "+v).join("\\n");
  const title=L.title||"";
  $("out").innerHTML=
    card("Title ("+title.length+"/80)",title)+
    card("Description",L.description||"")+
    (L.condition?card("Condition",L.condition):"")+
    (specs?card("Item specifics",specs):"")+
    '<div class="card"><h3>Pricing<button class="copy" onclick="cp(this)">COPY</button></h3>'+
    '<div class="val"><span class="price">'+money(P.suggested_list)+'</span>'+
    '<div class="floor">Floor '+money(P.floor)+' — '+esc(P.reasoning||"")+'</div></div></div>'+
    (L.keywords&&L.keywords.length?card("Keywords",L.keywords.join(", ")):"");}

// history (local)
function saveHist(L){
  const h=JSON.parse(localStorage.mf_history||"[]");
  h.unshift({t:L.title,d:Date.now(),L});
  localStorage.mf_history=JSON.stringify(h.slice(0,25));renderHist();}
function renderHist(){
  const h=JSON.parse(localStorage.mf_history||"[]");
  $("hist").innerHTML=h.length?'<label>Recent listings</label>'+h.map((x,i)=>
    '<div class="item" onclick="loadHist('+i+')"><div>'+esc(x.t)+'</div>'+
    '<span>'+new Date(x.d).toLocaleDateString()+'</span></div>').join(""):"";}
window.loadHist=(i)=>{const h=JSON.parse(localStorage.mf_history||"[]");
  render(h[i].L);window.scrollTo({top:$("out").offsetTop-80,behavior:"smooth"});};
renderHist();

// access code entry
$("codeLink").onclick=(e)=>{e.preventDefault();$("modal").style.display="flex";};
$("modalClose").onclick=()=>$("modal").style.display="none";
$("codeSave").onclick=async()=>{
  const c=$("codeIn").value.trim().toUpperCase();if(!c)return;
  const q=await fetch("/quota?code="+encodeURIComponent(c)).then(r=>r.json());
  if(q.paid){code=c;localStorage.mf_code=c;$("modal").style.display="none";showQuota();}
  else alert("Code not recognized — check for typos or email ${SUPPORT_EMAIL}.");};
</script></body></html>`;

