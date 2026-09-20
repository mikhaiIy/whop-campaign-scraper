import { CLIPPING_CSS, CLIPPING_HTML, CLIPPING_JS } from './clippingUi.js';

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Content Rewards — Campaign Console</title>
<link rel="icon" href="data:,">
<style>
*,*::before,*::after{box-sizing:border-box}
:root{
  color-scheme:light;
  --page:#f9f9f7; --surface:#fcfcfb; --surface-2:#f3f2ee; --surface-3:#ecebe5;
  --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7;--s8:#e34948;
  --good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;
  --deemph:#c3c2b7;
  --accent:#1c5cab; --on-accent:#ffffff;
  --focus:#2a78d6;
  --shadow:0 1px 2px rgba(11,11,11,.05),0 10px 28px -18px rgba(11,11,11,.35);
  --radius:10px;
}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){
  color-scheme:dark;
  --page:#0d0d0d; --surface:#1a1a19; --surface-2:#222220; --surface-3:#2c2c2a;
  --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;
  --deemph:#383835;
  --accent:#86b6ef; --on-accent:#0b0b0b;
  --focus:#3987e5;
  --shadow:0 1px 2px rgba(0,0,0,.5),0 10px 28px -18px rgba(0,0,0,.8);
}}
:root[data-theme="dark"]{
  color-scheme:dark;
  --page:#0d0d0d; --surface:#1a1a19; --surface-2:#222220; --surface-3:#2c2c2a;
  --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;
  --deemph:#383835;
  --accent:#86b6ef; --on-accent:#0b0b0b;
  --focus:#3987e5;
  --shadow:0 1px 2px rgba(0,0,0,.5),0 10px 28px -18px rgba(0,0,0,.8);
}
html,body{margin:0}
body{
  background:var(--page); color:var(--ink);
  font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--s1)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.topbar{
  position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:14px 24px;background:color-mix(in srgb,var(--page) 88%,transparent);
  backdrop-filter:blur(8px);border-bottom:1px solid var(--border);
}
.brand{display:flex;align-items:center;gap:12px}
.mark{width:30px;height:30px;border-radius:8px;background:var(--accent);position:relative;flex:none}
.mark::after{content:"";position:absolute;inset:8px 8px 8px 8px;border-radius:3px;background:var(--page)}
.topbar h1{font-size:15px;margin:0;letter-spacing:-.01em}
.topbar .sub{margin:1px 0 0;font-size:12px;color:var(--muted)}
.topbar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
main{max-width:1440px;margin:0 auto;padding:20px 24px 64px;display:flex;flex-direction:column;gap:16px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border)}
.panel-head h2{font-size:13px;margin:0;font-weight:650;letter-spacing:.01em}
.panel-head .hint{font-size:12px;color:var(--muted);margin:0}
.panel-body{padding:16px}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-2);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:3px 10px}
.chip .dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}
.chip[data-tone="good"] .dot{background:var(--good)}
.chip[data-tone="warn"] .dot{background:var(--warning)}
.chip[data-tone="crit"] .dot{background:var(--critical)}
.btn{
  font:inherit;font-size:12.5px;color:var(--ink);background:var(--surface);border:1px solid var(--border);
  border-radius:8px;padding:6px 12px;cursor:pointer;line-height:1.2;
}
.btn:hover{background:var(--surface-2)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.btn.primary:hover{background:color-mix(in srgb,var(--accent) 88%,var(--ink))}
.btn.ghost{background:transparent}
.btn[aria-pressed="true"]{background:color-mix(in srgb,var(--s1) 14%,var(--surface));border-color:var(--s1);color:var(--ink)}
.btn:disabled{opacity:.55;cursor:not-allowed}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow)}
.kpi .label{margin:0;font-size:12px;color:var(--muted)}
.kpi .value{margin:6px 0 0;font-size:28px;font-weight:650;letter-spacing:-.02em}
.kpi .sub{margin:4px 0 0;font-size:12px;color:var(--ink-2)}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.field{display:flex;flex-direction:column;gap:4px}
.field label{font-size:11.5px;color:var(--muted);letter-spacing:.01em}
.field input,.field select{
  font:inherit;font-size:13px;color:var(--ink);background:var(--surface);border:1px solid var(--axis);
  border-radius:8px;padding:6px 9px;min-height:34px;
}
.field input[type="search"]{min-width:210px}
.field.grow{flex:1 1 220px}
.tablewrap{overflow:auto;max-height:70vh;border-top:1px solid var(--border)}
table{width:100%;border-collapse:collapse}
thead th{
  position:sticky;top:0;z-index:2;background:var(--surface);text-align:left;font-size:11.5px;font-weight:600;
  color:var(--muted);white-space:nowrap;border-bottom:1px solid var(--axis);padding:0;
}
thead th .th{display:flex;align-items:center;gap:5px;width:100%;font:inherit;color:inherit;background:none;border:0;padding:9px 10px;cursor:pointer;text-align:left}
thead th.num .th{justify-content:flex-end}
thead th .th:hover{color:var(--ink)}
thead th .caret{font-size:9px;color:var(--s1);visibility:hidden}
thead th[aria-sort] .caret{visibility:visible}
tbody td{padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle;font-size:13px}
tbody tr:hover{background:var(--surface-2)}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.title{min-width:230px}
.camp{display:flex;align-items:center;gap:10px}
.thumb{width:40px;height:40px;border-radius:7px;object-fit:cover;background:var(--surface-3);flex:none;display:block}
.thumb.fallback{display:grid;place-items:center;font-size:15px;font-weight:650;color:var(--ink-2)}
.camp .name{font-weight:600;display:block;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.camp .brand{display:block;font-size:11.5px;color:var(--muted);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badges{display:flex;flex-wrap:wrap;gap:4px}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--ink-2);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:1px 7px}
.badge .dot{width:7px;height:7px;border-radius:50%;background:var(--muted)}
.progress{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.meter{width:72px;height:6px;border-radius:999px;background:color-mix(in srgb,var(--sev,var(--s1)) 16%,var(--surface));overflow:hidden;flex:none}
.meter > span{display:block;height:100%;border-radius:999px;background:var(--sev,var(--s1))}
.progress .pct{font-variant-numeric:tabular-nums;color:var(--ink-2);min-width:38px;text-align:right}
.pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;border-radius:999px;padding:2px 8px;border:1px solid;white-space:nowrap;flex:0 0 auto}
.pill.crit{color:var(--ink);background:color-mix(in srgb,var(--critical) 16%,var(--surface));border-color:color-mix(in srgb,var(--critical) 45%,var(--surface))}
.pill.warn{color:var(--ink);background:color-mix(in srgb,var(--warning) 20%,var(--surface));border-color:color-mix(in srgb,var(--warning) 50%,var(--surface))}
.pill .ico{font-size:10px}
.spark{display:block;overflow:visible}
.spark:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.empty{padding:28px;text-align:center;color:var(--muted)}
.grid2{display:grid;grid-template-columns:1.05fr 1fr;gap:16px;align-items:start}
@media (max-width:1000px){.grid2{grid-template-columns:1fr}}
.subhead{margin:0 0 10px;font-size:12px;font-weight:650;color:var(--ink-2)}
.formgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;border:1px solid var(--axis);border-radius:8px;padding:8px;min-height:42px}
.chips .btn{padding:4px 10px;font-size:12px}
.hr{height:1px;background:var(--border);margin:16px 0}
.prose{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12.5px;color:var(--ink-2);white-space:pre-wrap;margin:0;max-height:150px;overflow:auto}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.stat{border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:var(--surface)}
.stat .label{margin:0;font-size:11.5px;color:var(--muted)}
.stat .value{margin:4px 0 0;font-size:17px;font-weight:650;letter-spacing:-.01em}
.stat .value.small{font-size:13.5px;font-weight:600}
.banner{display:flex;gap:10px;align-items:flex-start;border-radius:8px;padding:11px 12px;font-size:12.5px;margin-bottom:12px}
.banner.warn{background:color-mix(in srgb,var(--critical) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--critical) 40%,var(--surface))}
.banner .ico{font-weight:700}
.logtable{width:100%;border-collapse:collapse;font-size:12px}
.logtable th{text-align:left;font-weight:600;color:var(--muted);border-bottom:1px solid var(--axis);padding:6px 8px;font-size:11px}
.logtable td{padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
.logtable td.args{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2)}
.ok{color:var(--good);font-weight:600}
.bad{color:var(--critical);font-weight:600}
.toast{position:fixed;right:20px;bottom:20px;z-index:60;background:var(--ink);color:var(--page);padding:10px 14px;border-radius:8px;font-size:13px;box-shadow:var(--shadow);opacity:0;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease;pointer-events:none}
.toast.show{opacity:1;transform:none}
#tooltip{position:fixed;z-index:70;pointer-events:none;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;box-shadow:var(--shadow);font-size:12px;max-width:240px}
#tooltip .tt-val{font-weight:650;color:var(--ink)}
#tooltip .tt-label{color:var(--muted);font-size:11px}
.loading main{opacity:.6}
${CLIPPING_CSS}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <div>
      <h1>Content Rewards — Campaign Console</h1>
      <p class="sub">Local view of <span class="mono">contentrewards.com/discover</span> · config + monitor</p>
    </div>
  </div>
  <div class="topbar-actions">
    <span id="fetch-chip" class="chip" data-tone="warn" role="status" aria-live="polite">Loading…</span>
    <button id="refresh" class="btn" type="button">Refresh data</button>
    <button id="theme" class="btn ghost" type="button" aria-pressed="false">Dark mode</button>
  </div>
</header>
<main id="main">
  <section aria-label="Catalog summary"><div class="kpis" id="kpis"></div></section>

  <section class="panel" aria-labelledby="filters-h">
    <div class="panel-head">
      <h2 id="filters-h">Filter campaigns</h2>
      <p class="hint" id="filter-hint">These controls scope the table below. Select a preset to load it in.</p>
    </div>
    <div class="panel-body">
      <div class="filters" id="filters"></div>
    </div>
  </section>

  <section class="panel" aria-labelledby="table-h">
    <div class="panel-head">
      <h2 id="table-h">Campaigns</h2>
      <p class="hint" id="table-count"></p>
    </div>
    <div class="tablewrap">
      <table id="campaigns">
        <caption class="visually-hidden">Sortable table of clipping campaigns from the public discover catalog</caption>
        <thead><tr id="thead-row"></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>

  <div class="grid2">
    <section class="panel" aria-labelledby="config-h">
      <div class="panel-head">
        <h2 id="config-h">Config editor</h2>
        <p class="hint" id="config-path"></p>
      </div>
      <div class="panel-body" id="config-body"></div>
    </section>

    <section class="panel" aria-labelledby="monitor-h">
      <div class="panel-head">
        <h2 id="monitor-h">Monitor</h2>
        <p class="hint">Source, cache, and agent tool activity</p>
      </div>
      <div class="panel-body" id="monitor-body"></div>
    </section>
  </div>
</main>
${CLIPPING_HTML}
<div id="tooltip" role="tooltip" hidden></div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
'use strict';
var state={
  campaigns:[], categories:[], platforms:[], types:[],
  config:null, status:null,
  sort:{key:'createdAtMs',dir:-1},
  filters:{category:'',platform:'',type:'',query:''},
  draft:null, selectedPreset:null, presetName:null, sparks:new WeakMap()
};
var PLATFORM_SLOT={instagram:1,tiktok:2,youtube:3,twitter:4,x:4,twitch:5,snapchat:6,facebook:7,kick:8,rumble:8};

function $(id){return document.getElementById(id);}
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined&&text!==null)n.textContent=String(text);return n;}
function clear(node){while(node.firstChild)node.removeChild(node.firstChild);}
function api(path,opts){return fetch(path,opts).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error((j&&j.error)||('HTTP '+r.status));return j;});});}

function money(v){
  if(v===null||v===undefined||!isFinite(v))return '—';
  var a=Math.abs(v);
  if(a>=1e6)return '$'+(Math.round(v/1e5)/10)+'M';
  if(a>=1e3)return '$'+(Math.round(v/100)/10)+'K';
  return '$'+(Math.round(v*100)/100);
}
function cpm(v){return (v===null||v===undefined)?'—':'$'+(Math.round(v*100)/100);}
function int(v){return Number(v||0).toLocaleString('en-US');}
function rate(v){return (v===null||v===undefined)?'—':money(v)+'/day';}
function age(ms){
  if(ms===null||ms===undefined)return 'never';
  var s=Math.max(0,Math.floor(ms/1000));
  if(s<60)return s+'s ago';
  var m=Math.floor(s/60); if(m<60)return m+'m ago';
  var h=Math.floor(m/60); if(h<48)return h+'h ago';
  return Math.floor(h/24)+'d ago';
}
function sevColor(p){return p>90?'var(--critical)':(p>70?'var(--warning)':'var(--s1)');}
function slotVar(name){var i=PLATFORM_SLOT[name];return i?'var(--s'+i+')':'var(--muted)';}
function bucketDate(start,i){
  if(!start)return 'Point '+(i+1);
  var d=new Date(start); if(isNaN(d.getTime()))return 'Point '+(i+1);
  d.setUTCDate(d.getUTCDate()+i); return d.toISOString().slice(0,10);
}
function median(values){
  if(!values.length)return null;
  var s=values.slice().sort(function(a,b){return a-b;});
  var m=Math.floor(s.length/2);
  return s.length%2?s[m]:(s[m-1]+s[m])/2;
}
function toast(msg){
  var t=$('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t=setTimeout(function(){t.classList.remove('show');},2600);
}

function renderChip(){
  var s=state.status, chip=$('fetch-chip');
  if(!s){chip.textContent='Loading…';chip.setAttribute('data-tone','warn');return;}
  var mode=s.fetchMode==='api'?'API':'HTML fallback';
  chip.textContent=mode+' · '+age(s.cacheAgeMs)+(s.cacheStale?' · stale':'');
  chip.setAttribute('data-tone',s.fetchMode==='api'&&!s.cacheStale?'good':(s.lastError?'crit':'warn'));
  if(s.lastError)chip.textContent+=' · error';
}

function renderKpis(){
  var box=$('kpis'); clear(box);
  var all=state.campaigns;
  var remaining=all.reduce(function(a,c){return a+(c.budgetRemaining||0);},0);
  var near=all.filter(function(c){return c.isNearlyExhausted;}).length;
  var cpmValues=all.map(function(c){return c.cpmUsd;}).filter(function(v){return v!==null&&v!==undefined;});
  var med=median(cpmValues);
  function tile(label,value,sub){
    var d=el('div','kpi');
    d.appendChild(el('p','label',label));
    d.appendChild(el('p','value',value));
    if(sub)d.appendChild(el('p','sub',sub));
    box.appendChild(d);
  }
  tile('Catalog size',int(all.length),state.categories.length+' categories · '+state.platforms.length+' platforms');
  tile('Remaining budget',money(remaining),'across all listed campaigns');
  tile('Nearly exhausted',int(near),all.length?Math.round(near/all.length*100)+'% of catalog over 90% spent':'—');
  tile('Median CPM',med===null?'—':'$'+(Math.round(med*100)/100),cpmValues.length+' campaigns pay per 1k views');
}

function option(value,label,selected){
  var o=document.createElement('option');o.value=value;o.textContent=label;if(selected)o.selected=true;return o;
}
function selectField(label,id,options,current,onChange){
  var wrap=el('div','field');var l=el('label',null,label);l.htmlFor=id;wrap.appendChild(l);
  var s=document.createElement('select');s.id=id;
  options.forEach(function(o){s.appendChild(option(o.value,o.label,String(o.value)===String(current)));});
  s.addEventListener('change',function(){onChange(s.value);});
  wrap.appendChild(s);return wrap;
}
function renderFilters(){
  var box=$('filters');clear(box);
  var presetOptions=[{value:'',label:'No preset'}];
  if(state.config){
    Object.keys(state.config.presets).sort().forEach(function(name){presetOptions.push({value:name,label:name});});
  }
  box.appendChild(selectField('Preset → load into filters','f-preset',presetOptions,state.selectedPreset,function(v){
    state.selectedPreset=v;applyPreset(v);renderTable();
  }));

  var cats=[{value:'',label:'All categories'}].concat(state.categories.map(function(c){return{value:c.category,label:c.category+' ('+c.count+')'};}));
  box.appendChild(selectField('Category','f-category',cats,state.filters.category,function(v){state.filters.category=v;renderTable();}));
  var plats=[{value:'',label:'All platforms'}].concat(state.platforms.map(function(p){return{value:p.value,label:p.value+' ('+p.count+')'};}));
  box.appendChild(selectField('Platform','f-platform',plats,state.filters.platform,function(v){state.filters.platform=v;renderTable();}));
  var types=[{value:'',label:'All types'}].concat(state.types.map(function(t){return{value:t.value,label:(t.value||'unknown')+' ('+t.count+')'};}));
  box.appendChild(selectField('Payout type','f-type',types,state.filters.type,function(v){state.filters.type=v;renderTable();}));

  var q=el('div','field grow');var ql=el('label',null,'Search title, brand, description');ql.htmlFor='f-query';q.appendChild(ql);
  var qi=el('input');qi.type='search';qi.id='f-query';qi.placeholder='e.g. roblox, trading, yomi';qi.value=state.filters.query;
  qi.addEventListener('input',function(){state.filters.query=qi.value.trim().toLowerCase();renderTable();});
  q.appendChild(qi);box.appendChild(q);

  var reset=el('button','btn ghost','Reset');reset.type='button';
  reset.addEventListener('click',function(){state.filters={category:'',platform:'',type:'',query:''};state.selectedPreset='';renderFilters();renderTable();});
  box.appendChild(reset);
}

function applyPreset(name){
  if(!name||!state.config)return;
  var p=state.config.presets[name];if(!p)return;
  state.filters.category=(p.categories&&p.categories[0])||'';
  state.filters.platform=(p.platforms&&p.platforms[0])||'';
  state.filters.type=p.type||'';
  state.filters.query='';
  renderFilters();
}

function filtered(){
  var f=state.filters;
  return state.campaigns.filter(function(c){
    if(f.category&&c.category!==f.category)return false;
    if(f.platform&&(c.platforms||[]).indexOf(f.platform)<0)return false;
    if(f.type&&c.type!==f.type)return false;
    if(f.query){
      var hay=(c.title+' '+c.brand+' '+(c.description||'')).toLowerCase();
      if(hay.indexOf(f.query)<0)return false;
    }
    return true;
  });
}
function sorted(rows){
  var k=state.sort.key,d=state.sort.dir;
  var copy=rows.slice();
  copy.sort(function(a,b){
    var av,bv;
    if(k==='title'){av=a.title.toLowerCase();bv=b.title.toLowerCase();return av<bv?-d:av>bv?d:0;}
    av=a[k];bv=b[k];
    var an=(av===null||av===undefined),bn=(bv===null||bv===undefined);
    if(an&&bn)return a.id.localeCompare(b.id);
    if(an)return 1; if(bn)return -1;
    return (av-bv)*d||a.id.localeCompare(b.id);
  });
  return copy;
}

var COLUMNS=[
  {key:'title',label:'Campaign',num:false},
  {key:'category',label:'Category',num:false},
  {key:'type',label:'Type',num:false},
  {key:'platforms',label:'Platforms',num:false},
  {key:'cpmUsd',label:'CPM',num:true},
  {key:'budgetRemaining',label:'Budget left',num:true},
  {key:'burnRatePerDay',label:'Burn / day',num:true},
  {key:'creatorCount',label:'Creators',num:true},
  {key:'progressPercentage',label:'Spent',num:true},
  {key:'trend',label:'30-day trend',num:false}
];
function renderHead(){
  var row=$('thead-row');clear(row);
  COLUMNS.forEach(function(col){
    var th=document.createElement('th');
    th.scope='col'; if(col.num)th.className='num';
    var active=state.sort.key===col.key;
    if(active)th.setAttribute('aria-sort',state.sort.dir===1?'ascending':'descending');
    var b=el('button','th');b.type='button';
    b.appendChild(el('span',null,col.label));
    b.appendChild(el('span','caret',active?(state.sort.dir===1?'▲':'▼'):'▲'));
    b.addEventListener('click',function(){
      if(state.sort.key===col.key)state.sort.dir=-state.sort.dir;
      else{state.sort.key=col.key;state.sort.dir=col.key==='title'?1:-1;}
      renderHead();renderTable();
    });
    th.appendChild(b);row.appendChild(th);
  });
}

function platformBadges(list){
  var wrap=el('div','badges');
  (list||[]).forEach(function(p){
    var b=el('span','badge');var dot=el('span','dot');dot.style.background=slotVar(p);b.appendChild(dot);b.appendChild(el('span',null,p));wrap.appendChild(b);
  });
  if(!wrap.children.length)wrap.appendChild(el('span','badge','—'));
  return wrap;
}
function thumbCell(c){
  var d=el('div','camp');
  if(c.thumbnail){
    var img=document.createElement('img');img.className='thumb';img.loading='lazy';img.alt='';img.src=c.thumbnail;
    img.addEventListener('error',function(){var f=el('span','thumb fallback',(c.title||'?').charAt(0).toUpperCase());img.replaceWith(f);});
    d.appendChild(img);
  }else{
    d.appendChild(el('span','thumb fallback',(c.title||'?').charAt(0).toUpperCase()));
  }
  var meta=el('div');
  var a=el('a','name',c.title||'(untitled)');a.href=c.url;a.target='_blank';a.rel='noopener noreferrer';a.title=c.title;
  meta.appendChild(a);
  meta.appendChild(el('span','brand',c.brand||'Unknown brand'));
  d.appendChild(meta);
  return d;
}
function meterCell(c){
  var d=el('div','progress');
  var m=el('div','meter');m.style.setProperty('--sev',sevColor(c.progressPercentage));
  var fill=el('span');fill.style.width=Math.max(0,Math.min(100,c.progressPercentage))+'%';m.appendChild(fill);
  m.setAttribute('role','img');
  m.setAttribute('aria-label',Math.round(c.progressPercentage)+'% of budget spent');
  d.appendChild(m);
  d.appendChild(el('span','pct',Math.round(c.progressPercentage)+'%'));
  if(c.isNearlyExhausted){
    var pill=el('span','pill crit');pill.appendChild(el('span','ico','▲'));pill.appendChild(el('span',null,'nearly out'));d.appendChild(pill);
  }
  return d;
}
function sparkline(series){
  var W=128,H=30,P=4,vals=series.values;
  if(!vals||vals.length<2)return el('span','muted','—');
  var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('class','spark');svg.setAttribute('width',W);svg.setAttribute('height',H);
  svg.setAttribute('viewBox','0 0 '+W+' '+H);svg.setAttribute('role','img');
  var max=Math.max.apply(null,vals),min=Math.min.apply(null,vals);
  if(max===min){max=min+1;}
  function X(i){return P+i*(W-2*P)/(vals.length-1);}
  function Y(v){return H-P-(v-min)/(max-min)*(H-2*P);}
  var label=(series.metric==='spend'?'Estimated daily spend':'Daily views')+', '+vals.length+' points';
  svg.setAttribute('aria-label',label);
  var baseline=document.createElementNS('http://www.w3.org/2000/svg','line');
  baseline.setAttribute('x1',P);baseline.setAttribute('x2',W-P);baseline.setAttribute('y1',H-P);baseline.setAttribute('y2',H-P);
  baseline.setAttribute('stroke','var(--grid)');baseline.setAttribute('stroke-width','1');
  svg.appendChild(baseline);
  var d='';
  for(var i=0;i<vals.length;i++){d+=(i?' L':'M')+X(i).toFixed(1)+' '+Y(vals[i]).toFixed(1);}
  var path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',d);path.setAttribute('fill','none');path.setAttribute('stroke','var(--s1)');
  path.setAttribute('stroke-width','2');path.setAttribute('stroke-linejoin','round');path.setAttribute('stroke-linecap','round');
  svg.appendChild(path);
  var dot=document.createElementNS('http://www.w3.org/2000/svg','circle');
  dot.setAttribute('cx',X(vals.length-1));dot.setAttribute('cy',Y(vals[vals.length-1]));dot.setAttribute('r','4');
  dot.setAttribute('fill','var(--s1)');dot.setAttribute('stroke','var(--surface)');dot.setAttribute('stroke-width','2');
  svg.appendChild(dot);
  svg.dataset.metric=series.metric;svg.dataset.start=series.start||'';
  state.sparks.set(svg,series);
  attachSpark(svg,series,X,Y);
  return svg;
}
function attachSpark(svg,series,X,Y){
  svg.setAttribute('tabindex','0');
  function show(clientX,clientY,i){
    var tt=$('tooltip');clear(tt);
    var row=el('div');
    row.appendChild(el('div','tt-val',(series.metric==='spend'?money(series.values[i]):int(series.values[i]))));
    row.appendChild(el('div','tt-label',(series.metric==='spend'?'estimated spend':'views')+' · '+bucketDate(series.start,i)));
    tt.appendChild(row);tt.hidden=false;
    var tw=tt.offsetWidth,th=tt.offsetHeight;
    var x=Math.min(window.innerWidth-tw-8,Math.max(8,clientX+12));
    var y=Math.max(8,clientY-th-10);
    tt.style.left=x+'px';tt.style.top=y+'px';
  }
  function hide(){$('tooltip').hidden=true;}
  function indexAt(clientX){
    var r=svg.getBoundingClientRect();
    var rel=(clientX-r.left)/r.width*128;
    var best=0,bd=Infinity;
    for(var i=0;i<series.values.length;i++){var dd=Math.abs(X(i)-rel);if(dd<bd){bd=dd;best=i;}}
    return best;
  }
  svg.addEventListener('pointermove',function(e){show(e.clientX,e.clientY,indexAt(e.clientX));});
  svg.addEventListener('pointerleave',hide);
  svg.addEventListener('blur',hide);
  var ki=series.values.length-1;
  svg.addEventListener('keydown',function(e){
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
      ki=Math.max(0,Math.min(series.values.length-1,ki+(e.key==='ArrowRight'?1:-1)));
      e.preventDefault();
      var r=svg.getBoundingClientRect();
      show(r.left+r.width*(X(ki)/128),r.top,ki);
    }else if(e.key==='Escape'){hide();}
  });
  svg.addEventListener('focus',function(){
    ki=series.values.length-1;
    var r=svg.getBoundingClientRect();
    show(r.left+r.width*(X(ki)/128),r.top,ki);
  });
}

function renderTable(){
  renderHead();
  var rows=sorted(filtered());
  var tbody=document.querySelector('#campaigns tbody');clear(tbody);
  $('table-count').textContent='Showing '+int(rows.length)+' of '+int(state.campaigns.length)+' campaigns';
  if(!rows.length){
    var tr=document.createElement('tr');var td=document.createElement('td');td.colSpan=COLUMNS.length;
    td.appendChild(el('div','empty','No campaigns match these filters.'));tr.appendChild(td);tbody.appendChild(tr);return;
  }
  rows.forEach(function(c){
    var tr=document.createElement('tr');
    tr.className='row-open';tr.tabIndex=0;
    tr.setAttribute('role','button');
    tr.setAttribute('aria-label','Open the clipping console for '+(c.title||c.id));
    tr.addEventListener('click',function(){openClip(c.id,c.title);});
    tr.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();openClip(c.id,c.title);}});
    var tdTitle=document.createElement('td');tdTitle.className='title';tdTitle.appendChild(thumbCell(c));tr.appendChild(tdTitle);
    tr.appendChild(el('td',null,c.category));
    tr.appendChild(el('td',null,c.type||'—'));
    var tdPlat=document.createElement('td');tdPlat.appendChild(platformBadges(c.platforms));tr.appendChild(tdPlat);
    tr.appendChild(el('td','num',cpm(c.cpmUsd)));
    tr.appendChild(el('td','num',money(c.budgetRemaining)));
    tr.appendChild(el('td','num',rate(c.burnRatePerDay)));
    tr.appendChild(el('td','num',int(c.creatorCount)));
    var tdProg=document.createElement('td');tdProg.appendChild(meterCell(c));tr.appendChild(tdProg);
    var tdSpark=document.createElement('td');tdSpark.appendChild(sparkline(c.series));tr.appendChild(tdSpark);
    tbody.appendChild(tr);
  });
}

function fetchSettingsSection(){
  var wrap=el('div');
  wrap.appendChild(el('p','subhead','Fetching'));
  var grid=el('div','formgrid');
  var deep=el('div','field');
  var dl=el('label',null,'Deep fetch (cursor API)');dl.htmlFor='c-deep';deep.appendChild(dl);
  var ds=document.createElement('select');ds.id='c-deep';
  ds.appendChild(option('true','Enabled','true'===String(state.draft.fetch.deep)));
  ds.appendChild(option('false','Disabled (HTML batch)','false'===String(state.draft.fetch.deep)));
  ds.addEventListener('change',function(){state.draft.fetch.deep=ds.value==='true';});
  deep.appendChild(ds);grid.appendChild(deep);
  [['maxPages','Max pages',1,100],['pageSize','Page size',1,100],['pageDelayMs','Page delay (ms)',0,10000]].forEach(function(spec){
    var f=el('div','field');var l=el('label',null,spec[1]);var id='c-'+spec[0];l.htmlFor=id;f.appendChild(l);
    var inp=el('input');inp.type='number';inp.id=id;inp.min=spec[2];inp.max=spec[3];inp.value=state.draft.fetch[spec[0]];
    inp.addEventListener('input',function(){var v=parseInt(inp.value,10);if(isFinite(v))state.draft.fetch[spec[0]]=v;});
    f.appendChild(inp);grid.appendChild(f);
  });
  wrap.appendChild(grid);
  return wrap;
}

function presetPicker(){
  var wrap=el('div');
  var names=Object.keys(state.draft.presets).sort();
  var bar=el('div','filters');
  bar.appendChild(selectField('Preset to edit','c-preset',names.map(function(n){return{value:n,label:n};}),state.selectedPreset,function(v){
    state.selectedPreset=v;startEditing(v);renderConfig();
  }));
  var nameField=el('div','field');var nl=el('label',null,'New preset name');nl.htmlFor='c-newname';nameField.appendChild(nl);
  var ni=el('input');ni.type='text';ni.id='c-newname';ni.placeholder='e.g. tech-tiktok';nameField.appendChild(ni);
  bar.appendChild(nameField);
  bar.appendChild((function(){var b=el('button','btn','Add preset');b.type='button';b.addEventListener('click',function(){
    var name=ni.value.trim();if(!name){toast('Enter a preset name first');return;}
    if(state.draft.presets[name]){toast('That preset already exists');return;}
    state.draft.presets[name]={};state.selectedPreset=name;startEditing(name);renderConfig();
  });return b;})());
  if(state.selectedPreset&&state.draft.presets[state.selectedPreset]){
    var del=el('button','btn ghost','Delete preset');del.type='button';
    del.addEventListener('click',function(){
      delete state.draft.presets[state.selectedPreset];
      var rest=Object.keys(state.draft.presets).sort();
      state.selectedPreset=rest[0]||null;startEditing(state.selectedPreset);renderConfig();
    });
    bar.appendChild(del);
  }
  wrap.appendChild(bar);
  return wrap;
}

function startEditing(name){
  if(!state.config)return;
  if(!name||!state.config.presets[name]){state.draft.preset=null;return;}
  state.draft.preset=JSON.parse(JSON.stringify(state.config.presets[name]));
}

function chipGroup(title,values,selected,onToggle){
  var wrap=el('div','field');
  wrap.appendChild(el('label',null,title));
  var box=el('div','chips');box.setAttribute('role','group');box.setAttribute('aria-label',title);
  values.forEach(function(v){
    var on=selected.indexOf(v)>=0;
    var b=el('button','btn',v);b.type='button';b.setAttribute('aria-pressed',on?'true':'false');
    b.addEventListener('click',function(){onToggle(v);renderConfig();});
    box.appendChild(b);
  });
  if(!values.length)box.appendChild(el('span','muted','No values in the current catalog'));
  wrap.appendChild(box);
  return wrap;
}
function numberField(label,id,value,min,step){
  var f=el('div','field');var l=el('label',null,label);l.htmlFor=id;f.appendChild(l);
  var inp=el('input');inp.type='number';inp.id=id;inp.min=min;inp.step=step||'any';
  inp.value=(value===undefined||value===null)?'':value;
  inp.addEventListener('input',function(){var v=inp.value.trim();state.draft.preset[id]=v===''?undefined:parseFloat(v);});
  state.draft.preset[id]=(value===undefined||value===null)?null:value;
  f.appendChild(inp);return f;
}
function boolField(label,id,value){
  var f=el('div','field');var l=el('label',null,label);l.htmlFor=id;f.appendChild(l);
  var s=document.createElement('select');s.id=id;
  s.appendChild(option('','Any',value===undefined));
  s.appendChild(option('true','Yes',value===true));
  s.appendChild(option('false','No',value===false));
  s.addEventListener('change',function(){state.draft.preset[id]=s.value===''?undefined:s.value==='true';});
  f.appendChild(s);return f;
}

function renderConfig(){
  var body=$('config-body');clear(body);
  if(!state.config||!state.draft){body.appendChild(el('p','muted','Config not loaded.'));return;}
  $('config-path').textContent=state.config.path||'';
  body.appendChild(presetPicker());
  body.appendChild(el('div','hr'));
  if(!state.selectedPreset||!state.draft.preset){
    body.appendChild(el('p','muted','Select a preset to edit its filters, or add a new one.'));
  }else{
    var p=state.draft.preset;
    function toggle(listName,value){
      var list=(p[listName]||[]).slice();
      var i=list.indexOf(value);
      if(i<0)list.push(value);else list.splice(i,1);
      p[listName]=list.length?list:undefined;
    }
    var catValues=state.categories.map(function(c){return c.category;});
    (p.categories||[]).forEach(function(c){if(catValues.indexOf(c)<0)catValues.push(c);});
    body.appendChild(chipGroup('Categories',catValues,p.categories||[],function(v){toggle('categories',v);}));
    var platValues=state.platforms.map(function(x){return x.value;});
    (p.platforms||[]).forEach(function(x){if(platValues.indexOf(x)<0)platValues.push(x);});
    body.appendChild(chipGroup('Platforms',platValues,p.platforms||[],function(v){toggle('platforms',v);}));
    var grid=el('div','formgrid');
    var typeOptions=[{value:'',label:'Any type'}].concat(state.types.map(function(t){return{value:t.value,label:t.value};}));
    grid.appendChild(selectField('Payout type','c-type',typeOptions,p.type||'',function(v){p.type=v||undefined;}));
    grid.appendChild(numberField('Min CPM (USD)','min_cpm',p.min_cpm,0));
    grid.appendChild(numberField('Max CPM (USD)','max_cpm',p.max_cpm,0));
    grid.appendChild(numberField('Min budget remaining (USD)','min_budget_remaining',p.min_budget_remaining,0));
    grid.appendChild(numberField('Limit','limit',p.limit,1,'1'));
    var sortOptions=[{value:'',label:'Any'},{value:'newest',label:'Newest'},{value:'cpm',label:'CPM'},{value:'budget_remaining',label:'Budget remaining'},{value:'creator_count',label:'Creator count'}];
    grid.appendChild(selectField('Sort by','c-sort',sortOptions,p.sort_by||'',function(v){p.sort_by=v||undefined;}));
    grid.appendChild(boolField('Requires application','requires_application',p.requires_application));
    grid.appendChild(boolField('Verified only','is_verified',p.is_verified));
    body.appendChild(grid);
    var ex=el('div','field');var exl=el('label',null,'Exclude brands (comma separated)');exl.htmlFor='c-exclude';ex.appendChild(exl);
    var exi=el('input');exi.type='text';exi.id='c-exclude';exi.value=(p.exclude_brands||[]).join(', ');
    exi.addEventListener('input',function(){var v=exi.value.split(',').map(function(s){return s.trim();}).filter(Boolean);p.exclude_brands=v.length?v:undefined;});
    ex.appendChild(exi);body.appendChild(ex);
  }
  body.appendChild(el('div','hr'));
  body.appendChild(fetchSettingsSection());
  body.appendChild(el('div','hr'));
  var def=el('div','field');var dl=el('label',null,'Default preset (applies when an agent calls list_campaigns with no arguments)');dl.htmlFor='c-default';def.appendChild(dl);
  var names=['(none)'].concat(Object.keys(state.draft.presets).sort());
  var dsel=document.createElement('select');dsel.id='c-default';
  names.forEach(function(n){dsel.appendChild(option(n==='(none)'?'':n,n,String(state.draft.defaultPreset||'')===(n==='(none)'?'':n)));});
  dsel.addEventListener('change',function(){state.draft.defaultPreset=dsel.value||null;});
  def.appendChild(dsel);body.appendChild(def);

  var save=el('button','btn primary','Save frontmatter');save.type='button';save.style.marginTop='14px';
  save.addEventListener('click',saveConfig);
  body.appendChild(save);

  var proseWrap=el('div');proseWrap.style.marginTop='16px';
  proseWrap.appendChild(el('p','subhead','Prose body (preserved as-is, never rewritten)'));
  proseWrap.appendChild(el('pre','prose',state.config.prose||'(no prose body yet)'));
  body.appendChild(proseWrap);
}

function saveConfig(){
  if(!state.draft)return;
  var payload={defaultPreset:state.draft.defaultPreset,presets:state.draft.presets,fetch:state.draft.fetch};
  api('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(function(res){state.config=res.config;state.draft=JSON.parse(JSON.stringify({presets:res.config.presets,defaultPreset:res.config.defaultPreset,fetch:res.config.fetch}));renderConfig();renderFilters();toast('Config saved');})
    .catch(function(e){toast('Save failed: '+e.message);});
}

function renderMonitor(){
  var box=$('monitor-body');clear(box);
  var s=state.status;
  if(!s){box.appendChild(el('p','muted','Status unavailable.'));return;}
  if(s.deepFetchError){
    var b=el('div','banner warn');b.appendChild(el('span','ico','!'));b.appendChild(el('span',null,'Deep fetch error: '+s.deepFetchError));box.appendChild(b);
  }else if(s.lastError){
    var b2=el('div','banner warn');b2.appendChild(el('span','ico','!'));b2.appendChild(el('span',null,'Last fetch error: '+s.lastError));box.appendChild(b2);
  }
  var grid=el('div','statgrid');
  function stat(label,value,small){
    var d=el('div','stat');d.appendChild(el('p','label',label));d.appendChild(el('p','value'+(small?' small':''),value));grid.appendChild(d);
  }
  stat('Active preset',s.defaultPreset||'(none)',true);
  stat('Fetch mode',s.fetchMode==='api'?'JSON API':(s.fetchMode==='html'?'HTML fallback':'—'),true);
  stat('Pages fetched',s.pagesFetched===null?'—':String(s.pagesFetched));
  stat('Catalog',s.catalogComplete?'complete':'capped',true);
  stat('Cache age',age(s.cacheAgeMs),true);
  stat('HTTP requests',int(s.requestCount));
  box.appendChild(grid);

  box.appendChild(el('div','hr'));
  box.appendChild(el('p','subhead','Agent tool calls ('+s.toolCalls.length+')'));
  if(!s.toolCalls.length){
    box.appendChild(el('p','muted','No tool calls recorded yet. This log fills as MCP clients (agents) call the tools on this server instance.'));
    return;
  }
  var t=el('table','logtable');
  var thead=document.createElement('thead');var hr=document.createElement('tr');
  ['Time','Tool','Arguments','Result','ms'].forEach(function(h){var th=document.createElement('th');th.scope='col';th.textContent=h;hr.appendChild(th);});
  thead.appendChild(hr);t.appendChild(thead);
  var tb=document.createElement('tbody');
  s.toolCalls.forEach(function(c){
    var tr=document.createElement('tr');
    tr.appendChild(el('td',null,new Date(c.at).toLocaleTimeString()));
    tr.appendChild(el('td',null,c.tool));
    var args=el('td','args mono',JSON.stringify(c.args||{}));args.title=JSON.stringify(c.args||{});
    tr.appendChild(args);
    var res=el('td');res.appendChild(el('span',c.ok?'ok':'bad',c.ok?'ok':'error'));tr.appendChild(res);
    tr.appendChild(el('td','num',String(c.durationMs)));
    tb.appendChild(tr);
  });
  t.appendChild(tb);box.appendChild(t);
}

function renderAll(){
  renderChip();renderKpis();renderFilters();renderTable();renderConfig();renderMonitor();
}

function load(){
  document.body.classList.add('loading');
  Promise.all([api('/api/campaigns'),api('/api/config'),api('/api/status')]).then(function(res){
    var camps=res[0], config=res[1], status=res[2];
    state.campaigns=camps.campaigns;state.categories=camps.categories;state.platforms=camps.platforms;state.types=camps.types;
    state.config=config;
    state.draft={presets:JSON.parse(JSON.stringify(config.presets)),defaultPreset:config.defaultPreset,fetch:config.fetch};
    var names=Object.keys(state.draft.presets).sort();
    state.selectedPreset=config.defaultPreset&&state.draft.presets[config.defaultPreset]?config.defaultPreset:(names[0]||null);
    startEditing(state.selectedPreset);
    state.status=status;
    document.body.classList.remove('loading');
    renderAll();
  }).catch(function(e){
    document.body.classList.remove('loading');
    toast('Load failed: '+e.message);
    var chip=$('fetch-chip');chip.textContent='Load failed';chip.setAttribute('data-tone','crit');
  });
}

$('refresh').addEventListener('click',function(){
  var btn=$('refresh');btn.disabled=true;btn.textContent='Refreshing…';
  api('/api/refresh',{method:'POST'}).then(function(res){
    state.campaigns=res.campaigns;state.categories=res.categories;state.platforms=res.platforms;state.types=res.types;state.status=res.status;
    renderAll();toast('Data refreshed');
  }).catch(function(e){toast('Refresh failed: '+e.message);}).finally(function(){btn.disabled=false;btn.textContent='Refresh data';});
});
$('theme').addEventListener('click',function(){
  var root=document.documentElement;
  var dark=root.getAttribute('data-theme')==='dark'||(!root.getAttribute('data-theme')&&window.matchMedia('(prefers-color-scheme: dark)').matches);
  var next=dark?'light':'dark';
  root.setAttribute('data-theme',next);
  try{localStorage.setItem('whop-theme',next);}catch(e){}
  $('theme').setAttribute('aria-pressed',next==='dark'?'true':'false');
  $('theme').textContent=next==='dark'?'Light mode':'Dark mode';
});
(function(){
  var forced=null;try{forced=new URLSearchParams(window.location.search).get('theme');}catch(e){}
  if(forced==='light'||forced==='dark'){localStorage.setItem('whop-theme',forced);}
  var saved=forced==='light'||forced==='dark'?forced:null;
  try{if(!saved)saved=localStorage.getItem('whop-theme');}catch(e){}
  if(saved){document.documentElement.setAttribute('data-theme',saved);
    $('theme').setAttribute('aria-pressed',saved==='dark'?'true':'false');
    $('theme').textContent=saved==='dark'?'Light mode':'Dark mode';}
})();
${CLIPPING_JS}
load();
</script>
</body>
</html>
`;
