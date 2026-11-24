/** Strictly read-only dashboard. Password stays in memory, never localStorage. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OrbitSuite • Control Dashboard</title><style>
:root{color-scheme:dark;font:15px system-ui,-apple-system,sans-serif;background:#080d19;color:#edf2ff}
*{box-sizing:border-box}body{margin:0;padding:24px;max-width:1200px;margin-inline:auto}
h1{font-size:clamp(1.5rem,5vw,2.4rem);margin:.1em 0}.muted{color:#9fadc9}
.top{display:flex;justify-content:space-between;gap:20px;align-items:end;flex-wrap:wrap}
.form{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:20px 0}
input,button{border-radius:9px;padding:11px 13px;border:1px solid #384768;color:#fff;background:#152138}
input{flex:1;min-width:200px}button{background:#355bef;cursor:pointer}button:hover{background:#476bf5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
.card{padding:16px;border:1px solid #22314e;background:#101a2d;border-radius:14px}
.big{font-size:1.8rem;font-weight:700}.label{color:#abbbda;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em}
section{margin-top:24px}table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;border-bottom:1px solid #27334c;padding:10px 7px;overflow-wrap:anywhere}
.scroll{overflow-x:auto}.error{color:#f5a9ae}.ok{color:#a5e1bf}code{color:#bcd0fb}
footer{margin-top:25px;color:#91a0bd;font-size:.85rem}
</style></head><body>
<header class="top"><div><div class="label">Private control panel</div><h1>OrbitSuite</h1><div class="muted">Metadata only • no media hosted here</div></div><div class="muted">Read-only</div></header>
<form class="form" id="access"><input id="key" type="password" autocomplete="off" placeholder="Dashboard access key" required aria-label="Dashboard access key"><button>Load dashboard</button><button type="button" id="refresh">Refresh</button></form>
<div id="message" aria-live="polite" class="muted">Enter your dashboard access key.</div>
<div id="stats" class="grid"></div>
<section><h2>Routes</h2><div class="card scroll"><table><thead><tr><th>ID</th><th>Source</th><th>Destination</th><th>Mode</th><th>Enabled</th></tr></thead><tbody id="routes"></tbody></table></div></section>
<section><h2>Queues</h2><div class="muted">Recent relay, manual save and media jobs. No source URLs or bytes.</div><div class="card scroll"><table><thead><tr><th>Kind</th><th>ID</th><th>Target</th><th>Status</th><th>Attempts</th></tr></thead><tbody id="queues"></tbody></table></div></section>
<section><h2>Known group topics</h2><div class="card scroll"><table><thead><tr><th>Chat</th><th>Topic ID</th><th>Title</th></tr></thead><tbody id="topics"></tbody></table></div></section>
<section><h2>Recent archive metadata</h2><div class="card scroll"><table><thead><tr><th>Type</th><th>Filename / Source</th><th>Destination</th><th>Saved</th></tr></thead><tbody id="archive"></tbody></table></div></section>
<footer>No account session, bot token or private media bytes are shown. Data is retrieved only after key verification.</footer>
<script src="/admin/app.js" defer></script></body></html>`;

export const DASHBOARD_SCRIPT = `(() => {
  'use strict';
  const byId = x => document.getElementById(x);
  let secret = '';
  const clean = parent => parent.replaceChildren();
  const cell = (row,value) => { const td=document.createElement('td');td.textContent=String(value ?? '');row.appendChild(td); };
  function addRow(parent,values){const tr=document.createElement('tr');for(const value of values)cell(tr,value);parent.appendChild(tr);}
  function stats(data){const container=byId('stats');clean(container);for(const [name,count] of Object.entries(data.stats || {})){
    const card=document.createElement('div');card.className='card';
    const value=document.createElement('div');value.className='big';value.textContent=String(count);
    const label=document.createElement('div');label.className='label';label.textContent=name.replaceAll('_',' ');
    card.append(value,label);container.appendChild(card);
  }}
  function render(data){stats(data);const routes=byId('routes');clean(routes);
    for(const item of data.routes||[])addRow(routes,[item.id,item.source+'/'+item.topic,item.dest+'/'+item.dest_topic,item.mode,item.enabled?'On':'Off']);
    const queues=byId('queues');clean(queues);
    for(const item of data.queues||[])addRow(queues,[item.kind,item.id,item.target,item.state,item.attempts]);
    const topics=byId('topics');clean(topics);
    for(const item of data.topics||[])addRow(topics,[item.chat,item.thread,item.title]);
    const archive=byId('archive');clean(archive);
    for(const item of data.archive||[])addRow(archive,[item.media_kind,item.filename||item.source+'/'+item.source_message_id,item.dest+'/'+item.dest_topic,new Date(item.saved_at*1000).toLocaleString()]);
  }
  async function refresh(){if(!secret){byId('message').textContent='Enter your dashboard access key.';return;}
    try{const response=await fetch('/admin/api',{headers:{Authorization:'Bearer '+secret},cache:'no-store'});
      if(!response.ok)throw new Error(response.status===403?'Access denied':'Request failed');
      render(await response.json());byId('message').textContent='Dashboard loaded. Data is read-only.';byId('message').className='ok';
    }catch(error){byId('message').textContent=error.message;byId('message').className='error';}
  }
  byId('access').addEventListener('submit',event=>{event.preventDefault();secret=byId('key').value;byId('key').value='';void refresh();});
  byId('refresh').addEventListener('click',()=>{void refresh();});
})();`;
