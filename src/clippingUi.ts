/**
 * The clipping drawer: a control surface for the five pipeline stages.
 * The stage rail is the signature element. Stages are numbered because the
 * pipeline is a real sequence: you cannot cut a clip before you transcribe it.
 */

export const CLIPPING_CSS = String.raw`
/* ---- clipping drawer ---- */
#clip-scrim{position:fixed;inset:0;background:rgba(11,11,11,.45);backdrop-filter:blur(2px);z-index:40}
#clip-scrim[hidden]{display:none}
#clip-drawer{position:fixed;top:0;right:0;bottom:0;width:min(960px,100vw);background:var(--page);
  --playhead:#e8912a; --track:color-mix(in srgb,var(--ink) 16%,transparent); --track-dim:color-mix(in srgb,var(--ink) 7%,transparent);
  border-left:1px solid var(--border);box-shadow:var(--shadow);z-index:41;display:flex;flex-direction:column;
  transform:translateX(0);transition:transform .18s ease}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) #clip-drawer{--playhead:#f0a63c;--track:color-mix(in srgb,var(--ink) 22%,transparent);--track-dim:color-mix(in srgb,var(--ink) 10%,transparent)}}
:root[data-theme="dark"] #clip-drawer{--playhead:#f0a63c;--track:color-mix(in srgb,var(--ink) 22%,transparent);--track-dim:color-mix(in srgb,var(--ink) 10%,transparent)}
#clip-drawer[hidden]{display:none}
@media (prefers-reduced-motion:reduce){#clip-drawer{transition:none}}
/* Cohesive controls inside the bench; the rail and next buttons carry no .btn class. */
#clip-drawer button{font:inherit;font-size:.8rem;color:var(--ink);background:var(--surface);border:1px solid var(--border);
  border-radius:8px;padding:6px 10px;cursor:pointer;line-height:1.2}
#clip-drawer button:hover{background:var(--surface-2)}
#clip-drawer button:disabled{opacity:.42;cursor:not-allowed}
#clip-drawer button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:650}
#clip-drawer button.primary:hover{background:color-mix(in srgb,var(--accent) 88%,var(--ink))}
#clip-drawer button.stop{background:transparent;border-color:var(--critical);color:var(--critical);font-weight:650}
.clip-head{display:flex;align-items:flex-start;gap:14px;padding:16px 22px 13px;border-bottom:1px solid var(--border);background:var(--surface);flex:none}
.clip-head h2{margin:0;font-size:1.12rem;line-height:1.25;letter-spacing:-.01em}
.clip-head .sub{margin:4px 0 0;font-size:.78rem;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.clip-eyebrow{display:block;font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.clip-close{margin-left:auto;flex:none}

/* Call-sheet bar: the single next action, given weight with the playhead accent. */
.clip-next{display:flex;align-items:center;gap:11px;padding:11px 22px;background:var(--surface-2);
  border-bottom:1px solid var(--border);border-left:3px solid var(--playhead);font-size:.9rem;flex:none}
.clip-next .lead{font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);flex:none}
.clip-next .what{font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clip-next button{margin-left:auto;flex:none}
.clip-next button.stop{border-left-color:var(--critical)}

/* ---- the stage timeline: the drawer's signature ---- */
.rail-wrap{position:relative;flex:none;background:var(--surface);border-bottom:1px solid var(--border)}
.rail{display:grid;grid-template-columns:repeat(5,1fr);gap:0;padding:0;margin:0;list-style:none}
.rail li{position:relative;padding:16px 14px 16px;border-right:1px solid var(--border);display:flex;flex-direction:column;gap:7px;min-width:0}
.rail li:last-child{border-right:0}
/* The track fills only as far as the work has really got. */
.rail li::before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:var(--track-dim)}
.rail li[data-state="done"]::before{background:var(--good)}
.rail li[data-state="running"]::before{background:var(--warning)}
.rail li[data-state="failed"]::before{background:var(--critical)}
.rail li[data-state="cancelled"]::before{background:var(--serious)}
.rail .no{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.62rem;color:var(--muted);letter-spacing:.1em;font-variant-numeric:tabular-nums}
.rail .name{font-size:.78rem;font-weight:650;letter-spacing:.01em}
.rail .fact{font-size:.74rem;color:var(--ink-2);font-variant-numeric:tabular-nums;line-height:1.35;min-height:2.5em}
.rail .fact.dim{color:var(--muted)}
.rail button{width:100%;font-size:.78rem;padding:6px 8px}
/* Exactly one button is primary at a time: the stage that can run next. */
.rail button.primary,.clip-next button.primary{background:var(--accent);color:var(--on-accent);border-color:transparent;font-weight:650}
.rail button.stop,.clip-next button.stop{background:transparent;border-color:var(--critical);color:var(--critical);font-weight:650}
.rail button:disabled{opacity:.42;cursor:not-allowed}
/* The stage that is up next is lifted out of the row and marked by the playhead. */
.rail li[data-next="true"]{background:var(--surface-2)}
.rail li[data-next="true"] .name{color:var(--ink)}
.rail li[data-next="true"] .no{color:var(--playhead)}
.rail .fact.bad{color:var(--critical)}
.rail li[data-state="running"] .name::after{content:"";display:inline-block;width:6px;height:6px;margin-left:6px;
  border-radius:50%;background:var(--warning);animation:pulse 1.1s ease-in-out infinite;vertical-align:middle}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.rail li[data-state="running"] .name::after{animation:none;opacity:1}}
/* Ruler: tick marks and timecodes under the track. */
.rail-ruler{position:relative;height:17px}
.rail-ruler::before{content:"";position:absolute;left:0;right:0;top:8px;height:1px;background:var(--track-dim)}
.rail-ruler .tick{position:absolute;top:8px;width:1px;height:5px;background:var(--track)}
.rail-ruler .tick span{position:absolute;top:6px;left:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.56rem;color:var(--muted);white-space:nowrap}
/* Playhead: one marker over the segment that has the work. */
.rail-wrap .playhead{position:absolute;top:0;bottom:17px;left:0;width:2px;background:var(--playhead);
  transform:translateX(-1px);transition:left .25s ease;pointer-events:none;z-index:3}
.rail-wrap .playhead::before{content:"";position:absolute;top:-1px;left:50%;transform:translateX(-50%);
  border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid var(--playhead)}
@media (prefers-reduced-motion:reduce){.rail-wrap .playhead{transition:none}}

.clip-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:18px 22px 40px;
  display:flex;flex-direction:column;gap:20px;overscroll-behavior:contain}
/* Sections keep their full height. Without this they shrink as flex items and
   the body reports nothing to scroll, which hides most of the campaign data. */
.clip-body > *{flex:0 0 auto}
.clip-sec{border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
/* The heading stays put while its own section scrolls past. */
.clip-sec > h3{margin:0;padding:11px 14px;font-size:.72rem;letter-spacing:.13em;text-transform:uppercase;
  color:var(--muted);background:var(--surface-2);border-bottom:1px solid var(--border);font-weight:650;
  position:sticky;top:-18px;z-index:2;border-radius:var(--radius) var(--radius) 0 0;
  display:flex;align-items:center;gap:10px}
.clip-sec .inner{padding:14px}
.clip-toggle{display:inline-flex;align-items:center;gap:7px;margin-left:auto;font-size:.68rem;letter-spacing:.02em;
  text-transform:none;color:var(--ink-2);background:var(--surface);border:1px solid var(--border);
  border-radius:999px;padding:3px 10px 3px 8px;cursor:pointer;user-select:none;font-weight:600}
.clip-toggle:hover{background:var(--surface-3)}
.clip-toggle input{accent-color:var(--playhead);width:14px;height:14px;margin:0;cursor:pointer}
.clip-toggle .tag{color:var(--muted);font-weight:500}
.clip-empty{color:var(--muted);font-size:.86rem;margin:0}

/* Spec fields. The value is verbatim campaign text and is never reworded. */
.spec{display:flex;flex-direction:column;gap:2px}
.spec-row{display:grid;grid-template-columns:200px 1fr;gap:12px;padding:8px 0;border-top:1px solid var(--border)}
.spec-row:first-child{border-top:0}
.spec-k{font-size:.74rem;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
.spec-v{font-size:.86rem;line-height:1.45;min-width:0}
.spec-v ul{margin:0;padding-left:18px}
.spec-v li{margin:2px 0}
.quote{display:block;margin-top:5px;padding-left:9px;border-left:2px solid var(--s1);
  font-size:.76rem;color:var(--ink-2);font-style:italic;word-break:break-word}
.quote.missing{border-left-color:var(--critical);color:var(--critical);font-style:normal}

/* Clips. The vertical render is the deliverable, so it leads. */
.clip-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.clip-card{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--surface-2);display:flex;flex-direction:column}
.clip-stage{position:relative;background:#000}
.clip-card video{width:100%;display:block;background:#000;aspect-ratio:16/9}
.clip-card.vertical video{aspect-ratio:9/16;max-height:560px}
.clip-badge{position:absolute;top:8px;left:8px;display:inline-flex;gap:6px;align-items:center;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.6rem;letter-spacing:.04em;text-transform:uppercase;
  font-weight:650;color:#fff;background:rgba(11,11,11,.64);border:1px solid rgba(255,255,255,.18);
  border-radius:999px;padding:3px 8px;backdrop-filter:blur(4px)}
.clip-badge .dot{width:6px;height:6px;border-radius:50%;background:var(--good);flex:none}
.clip-meta{padding:9px 11px;font-size:.74rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--ink-2);font-variant-numeric:tabular-nums;display:flex;flex-direction:column;gap:3px;border-top:1px solid var(--border)}
.clip-meta .drift{color:var(--good)}
.clip-meta .drift.off{color:var(--critical)}
.clip-said{padding:0 11px 11px;font-size:.76rem;color:var(--ink-2);font-style:italic;line-height:1.4;margin:0}

/* Videos. */
.vid{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--border);font-size:.83rem}
.vid:first-child{border-top:0}
.vid .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vid .d{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.74rem;color:var(--muted);flex:none}
.vid[aria-selected="true"]{background:var(--surface-3)}
.vid button{flex:none;font-size:.74rem;padding:4px 9px}

/* Jobs. */
.job{display:grid;grid-template-columns:8px 1fr auto;gap:10px;align-items:baseline;padding:7px 0;border-top:1px solid var(--border);font-size:.82rem}
.job:first-child{border-top:0}
.job .dot{width:8px;height:8px;border-radius:50%;background:var(--deemph);align-self:center}
.job[data-state="done"] .dot{background:var(--good)}
.job[data-state="running"] .dot{background:var(--warning)}
.job[data-state="failed"] .dot{background:var(--critical)}
.job[data-state="cancelled"] .dot{background:var(--serious)}
.job .when{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.73rem;color:var(--muted);font-variant-numeric:tabular-nums}
.job .err{grid-column:2/-1;color:var(--critical);font-size:.78rem;margin-top:2px}
.job .prog{grid-column:2/-1;color:var(--muted);font-size:.78rem;margin-top:2px}
.clip-warn{margin:10px 0 0;padding:9px 11px;border-radius:8px;background:var(--surface-3);
  font-size:.78rem;color:var(--ink-2);border-left:3px solid var(--warning)}
.trust{font-size:.73rem;color:var(--muted);padding:10px 22px 12px;line-height:1.4;flex:none;margin:0}
/* On a narrow screen the rail stacks instead of squeezing to five columns. */
@media (max-width:760px){
  .rail{grid-template-columns:repeat(2,1fr)}
  .rail li{border-bottom:1px solid var(--border)}
  .spec-row{grid-template-columns:1fr;gap:3px}
  .rail-wrap .playhead{display:none}
}
.row-open{cursor:pointer}
tbody tr.row-open:hover{background:var(--surface-2)}
`;

export const CLIPPING_HTML = String.raw`
<div id="clip-scrim" hidden></div>
<aside id="clip-drawer" hidden role="dialog" aria-modal="true" aria-labelledby="clip-title">
  <div class="clip-head">
    <div>
      <span class="clip-eyebrow">Clipping workbench</span>
      <h2 id="clip-title">Campaign</h2>
      <p class="sub" id="clip-sub"></p>
    </div>
    <button type="button" class="clip-close" id="clip-close">Close</button>
  </div>
  <div class="clip-next">
    <span class="lead">Next</span>
    <span class="what" id="clip-next-what">Crawl the brief</span>
    <button type="button" id="clip-next-go">Crawl brief</button>
  </div>
  <div class="rail-wrap">
    <div class="playhead" id="clip-playhead" aria-hidden="true"></div>
    <ol class="rail" id="clip-rail" aria-label="Pipeline stages"></ol>
    <div class="rail-ruler" id="clip-ruler" aria-hidden="true"></div>
  </div>
  <p class="trust">Brief text below is third-party campaign copy, shown word for word. A rule that is absent stays empty and is never guessed.</p>
  <div class="clip-body" id="clip-body"></div>
</aside>
`;

export const CLIPPING_JS = String.raw`
/* ---- clipping drawer ---- */
var STAGES=[
  {key:'brief',   name:'Brief',   run:'Crawl brief',   busy:'Crawling…',    next:'Crawl the brief to read the campaign rules.'},
  {key:'extract', name:'Spec',    run:'Extract spec',  busy:'Reading…',     next:'Extract the clip spec from the brief.'},
  {key:'footage', name:'Footage', run:'Find videos',   busy:'Listing…',     next:'Find the source videos.'},
  {key:'moments', name:'Moments', run:'Select moments',busy:'Transcribing…',next:'Pick a video, then select moments.'},
  {key:'clips',   name:'Clips',   run:'Cut clips',     busy:'Cutting…',     next:'Cut the clips.'}
];
var clip={id:null,title:null,view:null,videoId:null,videoUrl:null,timer:null,railSig:null,bodySig:null,pollMs:0,enhance:false};

function clipFetch(path,options){return fetch(path,options).then(function(r){return r.json().then(function(b){if(!r.ok)throw new Error(b.error||('HTTP '+r.status));return b;});});}

function openClip(id,title){
  clip.id=id;clip.title=title||id;clip.view=null;
  $('clip-title').textContent=clip.title;
  $('clip-sub').textContent=id;
  $('clip-drawer').hidden=false;$('clip-scrim').hidden=false;
  document.body.style.overflow='hidden';
  $('clip-close').focus();
  refreshClip();
  setPoll(1500);
}
/* Poll fast while work runs, slowly when idle. Re-rendering costs a playing clip its position. */
function setPoll(ms){
  if(clip.pollMs===ms&&clip.timer)return;
  if(clip.timer)clearInterval(clip.timer);
  clip.pollMs=ms;
  clip.timer=setInterval(refreshClip,ms);
}
/*
 * Two signatures, on purpose.
 * The rail carries live progress and is cheap to redraw.
 * The body holds <video> elements, so it must only redraw when its own data
 * changes. Progress text is deliberately left out: a progress tick that
 * rebuilt the body would restart whatever clip is playing.
 */
function railSig(v){
  return v.jobs.map(function(j){return j.id+j.state+(j.progress||'')+(j.error||'');}).join('|')
    +'~'+Object.keys(v.busy).map(function(k){return k+v.busy[k];}).join(',')
    +'~'+bodySig(v);
}
function bodySig(v){
  var w=v.workspace;
  return [
    v.jobs.map(function(j){return j.id+j.state+(j.error||'');}).join('|'),
    w.brief?w.brief.characters+'/'+w.brief.sources.length+'/'+w.brief.needsBrowser:'-',
    w.clipSpec?countSpecFields(w.clipSpec):'-',
    w.footage?w.footage.videos.length+'/'+w.footage.deferred.length:'-',
    w.moments?w.moments.videoId+'/'+w.moments.candidates.length:'-',
    (v.clips||[]).map(function(c){return c.path+'|'+(c.verticalPath||'');}).join(','),
    clip.videoId||'-',
    clip.enhance?'enhance':'plain'
  ].join('~');
}
function closeClip(){
  $('clip-drawer').hidden=true;$('clip-scrim').hidden=true;
  document.body.style.overflow='';
  if(clip.timer){clearInterval(clip.timer);clip.timer=null;}
  clip.pollMs=0;clip.railSig=null;clip.bodySig=null;clip.id=null;
}
function refreshClip(){
  if(!clip.id)return;
  clipFetch('/api/clipping/view?campaignId='+encodeURIComponent(clip.id)).then(function(v){
    clip.view=v;
    if(v.workspace.title&&v.workspace.title!==clip.title){clip.title=v.workspace.title;$('clip-title').textContent=clip.title;}
    var busy=Object.keys(v.busy).some(function(k){return v.busy[k];});
    setPoll(busy?1500:8000);
    var rs=railSig(v);
    if(rs!==clip.railSig){clip.railSig=rs;renderRail();}
    var bs=bodySig(v);
    if(bs!==clip.bodySig){clip.bodySig=bs;renderClipBody();}
  }).catch(function(e){toast(e.message);});
}
function runStage(stage){
  if(!clip.id)return;
  var body={campaignId:clip.id};
  if(stage==='moments'||stage==='clips'){
    if(!clip.videoId){toast('Pick a video first.');return;}
    body.videoId=clip.videoId;if(clip.videoUrl)body.videoUrl=clip.videoUrl;
    if(stage==='clips'&&clip.enhance)body.enhance=true;
  }
  clipFetch('/api/clipping/run/'+stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(){refreshClip();}).catch(function(e){toast(e.message);});
}
function lastJobFor(stage){
  var jobs=(clip.view&&clip.view.jobs)||[];
  for(var i=0;i<jobs.length;i++){if(jobs[i].stage===stage)return jobs[i];}
  return null;
}
function stageState(stage){
  var job=lastJobFor(stage);
  if(!job)return 'idle';
  if(job.state==='queued')return 'running';
  return job.state;
}
/* Why a stage cannot run yet, or null when it can. Keeps the operator off dead ends. */
function stageBlocker(stage){
  var w=(clip.view&&clip.view.workspace)||{};
  if(stage==='extract'&&!w.brief)return 'Crawl the brief first.';
  if(stage==='footage'&&!w.brief)return 'Crawl the brief first.';
  if((stage==='moments'||stage==='clips')&&!w.clipSpec)return 'Extract the clip spec first.';
  if((stage==='moments'||stage==='clips')&&!clip.videoId)return 'Pick a video first.';
  return null;
}
function stageFact(stage){
  var w=(clip.view&&clip.view.workspace)||{};
  if(stage==='brief')  return w.brief?int(w.brief.characters)+' chars · '+w.brief.sources.length+' sources'+(w.brief.needsBrowser?' · '+w.brief.needsBrowser+' need browser':''):'No brief yet.';
  if(stage==='extract')return w.clipSpec?countSpecFields(w.clipSpec)+' rules found':'No spec yet.';
  if(stage==='footage')return w.footage?int(w.footage.videos.length)+' videos · '+w.footage.channels+' channels':'No videos yet.';
  if(stage==='moments')return w.moments?w.moments.candidates.length+' moments on '+w.moments.videoId:'No moments yet.';
  if(stage==='clips'){
    var cl=(clip.view&&clip.view.clips)||[];
    if(!cl.length)return 'No clips yet.';
    var disk=cl.filter(function(c){return c.fromDisk;}).length;
    var vert=cl.filter(function(c){return c.verticalPath;}).length;
    return cl.length+' clips'+(vert?' · '+vert+' vertical':'')+(disk?' ('+disk+' from disk)':'');
  }
  return '';
}
function renderRail(){
  var rail=$('clip-rail');rail.textContent='';
  var busy=(clip.view&&clip.view.busy)||{};
  var nextStage=STAGES.find(function(s){return stageState(s.key)!=='done'&&!stageBlocker(s.key);})
              ||STAGES.find(function(s){return stageState(s.key)!=='done';})
              ||STAGES[STAGES.length-1];
  var runningStage=STAGES.find(function(s){return busy[s.key];})||null;

  STAGES.forEach(function(s,i){
    var state=stageState(s.key);
    var blocker=stageBlocker(s.key);
    var li=document.createElement('li');
    li.setAttribute('data-state',state);
    if(s.key===nextStage.key&&!runningStage)li.setAttribute('data-next','true');
    li.appendChild(el('span','no','00:0'+(i+1)));
    li.appendChild(el('span','name',s.name));
    var job=lastJobFor(s.key);
    var factText,dim;
    if(busy[s.key]&&job&&job.progress){factText=job.progress;dim=false;}
    else if(state==='failed'&&job&&job.error){factText=job.error;dim=false;}
    else if(blocker&&state==='idle'){factText=blocker;dim=true;}
    else {factText=stageFact(s.key);dim=factText.indexOf('No ')===0;}
    var fact=el('span','fact'+(dim?' dim':''),factText);
    if(state==='failed')fact.className='fact bad';
    li.appendChild(fact);
    var b=el('button',null,busy[s.key]?'Stop':s.run);
    b.type='button';
    if(busy[s.key]){
      b.className='stop';
      b.addEventListener('click',function(){cancelStage(s.key);});
    } else {
      b.disabled=!!blocker;
      if(blocker)b.title=blocker;
      if(s.key===nextStage.key&&!runningStage)b.className='primary';
      b.addEventListener('click',function(){runStage(s.key);});
    }
    li.appendChild(b);
    rail.appendChild(li);
  });

  var active=runningStage?STAGES.indexOf(runningStage):STAGES.indexOf(nextStage);
  var ph=$('clip-playhead');if(ph)ph.style.left=(Math.max(0,active)/STAGES.length*100)+'%';
  var ruler=$('clip-ruler');
  if(ruler){
    ruler.textContent='';
    STAGES.forEach(function(s,i){
      var tick=el('span','tick');tick.style.left=(i/STAGES.length*100)+'%';
      tick.appendChild(el('span',null,'00:0'+(i+1)));
      ruler.appendChild(tick);
    });
  }

  var what=$('clip-next-what');
  var go=$('clip-next-go');
  if(runningStage){
    var rj=lastJobFor(runningStage.key);
    what.textContent=(rj&&rj.progress)?rj.progress:runningStage.busy;
    go.textContent='Stop';go.disabled=false;go.className='stop';
    go.onclick=function(){cancelStage(runningStage.key);};
  } else {
    var blocked=stageBlocker(nextStage.key);
    what.textContent=blocked||nextStage.next;
    go.textContent=nextStage.run;go.disabled=!!blocked;go.className='primary';
    if(blocked)go.title=blocked; else go.removeAttribute('title');
    go.onclick=function(){runStage(nextStage.key);};
  }
}
function cancelStage(stage){
  var job=lastJobFor(stage);
  if(!job)return;
  clipFetch('/api/clipping/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:job.id})})
    .then(function(){refreshClip();}).catch(function(e){toast(e.message);});
}
function countSpecFields(spec){
  var n=0;
  Object.keys(spec).forEach(function(k){
    var f=spec[k];
    if(!f||typeof f!=='object'||!('value' in f))return;
    var v=f.value;
    if(v===null||v===undefined)return;
    if(Array.isArray(v)&&v.length===0)return;
    n++;
  });
  return n;
}
function section(title,control){
  var s=el('section','clip-sec');
  var h=el('h3',null,title);
  if(control)h.appendChild(control);
  s.appendChild(h);
  var inner=el('div','inner');s.appendChild(inner);
  return {node:s,inner:inner};
}
function enhanceToggle(){
  var label=el('label','clip-toggle');
  var cb=document.createElement('input');cb.type='checkbox';cb.checked=!!clip.enhance;
  cb.setAttribute('aria-label','Render vertical clips with captions and normalized loudness');
  cb.addEventListener('change',function(){clip.enhance=cb.checked;clip.bodySig=null;clip.railSig=null;renderClipBody();renderRail();});
  label.appendChild(cb);
  label.appendChild(document.createTextNode('Vertical + captions'));
  label.appendChild(el('span','tag','1080×1920 · −14 LUFS'));
  label.title='Burn 9:16 clips with word-synced captions and −14 LUFS loudness normalization.';
  return label;
}
function renderClipBody(){
  var body=$('clip-body');var scroll=body.scrollTop;body.textContent='';
  var w=clip.view.workspace;
  var clips=(clip.view&&clip.view.clips)||[];
  if(clips.length)body.appendChild(clipsSection(clips).node);
  if(w.footage)body.appendChild(videosSection(w).node);
  if(w.clipSpec)body.appendChild(specSection(w).node);
  if(w.brief)body.appendChild(briefSection(w).node);
  body.appendChild(jobsSection().node);
  body.scrollTop=scroll;
}
function clipsSection(clips){
  var s=section('Clips · '+clips.length,enhanceToggle());
  var grid=el('div','clip-grid');
  clips.forEach(function(c){
    var vertical=!!c.verticalPath;
    var card=el('div','clip-card'+(vertical?' vertical':''));
    var stage=el('div','clip-stage');
    var v=document.createElement('video');
    v.controls=true;v.preload='none';v.playsInline=true;
    v.src='/clips/media?path='+encodeURIComponent(c.verticalPath||c.path);
    stage.appendChild(v);
    if(vertical){
      var badge=el('span','clip-badge');
      badge.appendChild(el('span','dot'));
      badge.appendChild(document.createTextNode('9:16 · captions · −14 LUFS'));
      stage.appendChild(badge);
    }
    card.appendChild(stage);
    var meta=el('div','clip-meta');
    var span=(c.durationSeconds!=null?c.durationSeconds.toFixed(2)+'s':'—');
    if(c.start!=null&&c.end!=null)span+='  ('+c.start.toFixed(2)+' → '+c.end.toFixed(2)+')';
    meta.appendChild(el('span',null,span));
    meta.appendChild(el('span',null,vertical?'vertical render':'clean cut · horizontal'));
    if(c.expectedDurationSeconds!=null&&c.durationSeconds!=null){
      var drift=Math.abs(c.durationSeconds-c.expectedDurationSeconds);
      meta.appendChild(el('span','drift'+(drift>0.2?' off':''),'drift '+drift.toFixed(3)+'s vs requested'));
    } else if(c.fromDisk){
      meta.appendChild(el('span','drift dim','read from disk'));
    }
    card.appendChild(meta);
    if(c.reason)card.appendChild(el('p','clip-said',c.reason));
    grid.appendChild(card);
  });
  s.inner.appendChild(grid);
  return s;
}
function videosSection(w){
  var s=section('Source videos · '+w.footage.videos.length);
  if(!w.footage.videos.length){
    s.inner.appendChild(el('p','clip-empty','No videos were found. The brief may point at a Drive folder instead of a channel.'));
  }
  w.footage.videos.slice(0,40).forEach(function(v){
    var row=el('div','vid');
    row.setAttribute('aria-selected',clip.videoId===v.id?'true':'false');
    row.appendChild(el('span','t',v.title||v.id));
    row.appendChild(el('span','d',v.durationSeconds?fmtDur(v.durationSeconds):'—'));
    var b=el('button',null,clip.videoId===v.id?'Selected':'Select');
    b.type='button';
    b.addEventListener('click',function(){clip.videoId=v.id;clip.videoUrl=v.url||null;clip.bodySig=bodySig(clip.view);clip.railSig=railSig(clip.view);renderClipBody();renderRail();});
    row.appendChild(b);
    s.inner.appendChild(row);
  });
  w.footage.deferred.forEach(function(d){s.inner.appendChild(el('p','clip-warn',d));});
  return s;
}
function fmtDur(sec){var m=Math.floor(sec/60),r=Math.round(sec%60);return m+':'+String(r).padStart(2,'0');}
function specSection(w){
  var spec=w.clipSpec;
  var s=section('Clip spec · '+countSpecFields(spec)+' rules');
  var list=el('div','spec');
  Object.keys(spec).forEach(function(k){
    var f=spec[k];
    if(!f||typeof f!=='object'||!('value' in f))return;
    var v=f.value;
    if(v===null||v===undefined)return;
    if(Array.isArray(v)&&v.length===0)return;
    var row=el('div','spec-row');
    row.appendChild(el('div','spec-k',k));
    var cell=el('div','spec-v');
    if(Array.isArray(v)){
      var ul=document.createElement('ul');
      v.forEach(function(item){ul.appendChild(el('li',null,String(item)));});
      cell.appendChild(ul);
    } else {
      cell.appendChild(el('span',null,String(v)));
    }
    (f.provenance||[]).forEach(function(p){
      cell.appendChild(el('span','quote','“'+p.quote+'”'));
    });
    if(!f.provenance||!f.provenance.length)cell.appendChild(el('span','quote missing','No source quote. Treat this value as unverified.'));
    row.appendChild(cell);
    list.appendChild(row);
  });
  s.inner.appendChild(list);
  (w.clipSpecWarnings||[]).forEach(function(x){s.inner.appendChild(el('p','clip-warn',x));});
  return s;
}
function briefSection(w){
  var s=section('Brief sources · '+int(w.brief.characters)+' chars');
  w.brief.sources.forEach(function(src){
    var row=el('div','vid');
    row.appendChild(el('span','t',src.url));
    row.appendChild(el('span','d',src.status+(src.bytes?' · '+int(src.bytes)+'B':'')));
    s.inner.appendChild(row);
  });
  if(w.brief.needsBrowser){
    var p=el('p','clip-warn',w.brief.needsBrowser+' source(s) need the browser tier. Run the brief again with the browser on.');
    var b=el('button',null,'Crawl with browser');b.type='button';
    b.addEventListener('click',function(){
      clipFetch('/api/clipping/run/brief',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({campaignId:clip.id,browser:true,refresh:true})})
        .then(function(){refreshClip();}).catch(function(e){toast(e.message);});
    });
    p.appendChild(document.createTextNode(' '));p.appendChild(b);
    s.inner.appendChild(p);
  }
  return s;
}
function jobsSection(){
  var jobs=clip.view.jobs||[];
  var s=section('Jobs · '+jobs.length);
  if(!jobs.length)s.inner.appendChild(el('p','clip-empty','No jobs have run for this campaign yet.'));
  jobs.slice(0,12).forEach(function(j){
    var row=el('div','job');
    row.setAttribute('data-state',j.state);
    row.appendChild(el('span','dot'));
    row.appendChild(el('span',null,j.label));
    row.appendChild(el('span','when',j.durationMs!=null?(j.durationMs/1000).toFixed(1)+'s':j.state));
    if(j.error)row.appendChild(el('div','err',j.error));
    else if(j.progress)row.appendChild(el('div','prog',j.progress));
    s.inner.appendChild(row);
  });
  return s;
}
$('clip-close').addEventListener('click',closeClip);
$('clip-scrim').addEventListener('click',closeClip);
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!$('clip-drawer').hidden)closeClip();});
`;
