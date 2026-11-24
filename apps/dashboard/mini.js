/** Owner-only Telegram Mini App presentation: all values are rendered as text. */
export const MINI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OrbitSuite Mini App</title>
<style>
:root{color-scheme:dark;font:15px system-ui,sans-serif;background:#101526;color:#f5f6fc}
body{margin:0;padding:18px;max-width:780px;margin-inline:auto}header{display:flex;align-items:center;justify-content:space-between;gap:12px}
h1{font-size:1.6rem;margin:.3em 0}h2{font-size:1.1rem;margin-top:24px}.muted{color:#b3bfd4}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:15px}
.tile,.scroll{border:1px solid #344361;background:#1a2439;border-radius:12px;padding:12px}.num{font-size:1.6rem;font-weight:700}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #33445c;overflow-wrap:anywhere}
.scroll{overflow-x:auto}button{padding:10px 13px;background:#4566f7;color:white;border:0;border-radius:8px}
#status{margin-top:18px}footer{margin:28px 0;font-size:.8rem}
</style><script src="https://telegram.org/js/telegram-web-app.js?65"></script>
<script src="/mini/app.js" defer></script></head><body>
<header><div><div class="muted">Private account overview</div><h1>OrbitSuite</h1></div><button id="refresh" type="button">Refresh</button></header>
<div id="status" role="status">Verifying Telegram identity…</div><div id="stats" class="grid"></div>
<h2>Routes</h2><div class="scroll"><table><thead><tr><th>ID</th><th>Source</th><th>Destination</th><th>Enabled</th></tr></thead><tbody id="routes"></tbody></table></div>
<h2>Queue</h2><div class="scroll"><table><thead><tr><th>Kind</th><th>Target</th><th>Status</th></tr></thead><tbody id="queues"></tbody></table></div>
<h2>Topics</h2><div class="scroll"><table><thead><tr><th>Chat</th><th>Topic</th><th>Title</th></tr></thead><tbody id="topics"></tbody></table></div>
<h2>Archive metadata</h2><div class="scroll"><table><thead><tr><th>File</th><th>Target</th></tr></thead><tbody id="archive"></tbody></table></div>
<footer class="muted">Read-only. No Telegram media or sessions are stored in this page.</footer>
</body></html>`;

export const MINI_SCRIPT = `(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const app=window.Telegram?.WebApp;
  if(app){app.ready();app.expand();}
  function addRow(parent,fields){const row=document.createElement('tr');for(const value of fields){
    const cell=document.createElement('td');cell.textContent=String(value??'');row.appendChild(cell);
  }parent.appendChild(row);}
  function render(data){const stat=$('stats');stat.replaceChildren();for(const [key,value] of Object.entries(data.stats||{})){
    const tile=document.createElement('div');tile.className='tile';const num=document.createElement('div');num.className='num';
    num.textContent=String(value);const label=document.createElement('div');label.textContent=key.replaceAll('_',' ');
    tile.append(num,label);stat.appendChild(tile);
  }
  const routes=$('routes');routes.replaceChildren();for(const r of data.routes||[])addRow(routes,[r.id,r.source+'/'+r.topic,r.dest+'/'+r.dest_topic,r.enabled?'Yes':'No']);
  const queues=$('queues');queues.replaceChildren();for(const q of data.queues||[])addRow(queues,[q.kind,q.target,q.state]);
  const topics=$('topics');topics.replaceChildren();for(const t of data.topics||[])addRow(topics,[t.chat,t.thread,t.title]);
  const archive=$('archive');archive.replaceChildren();for(const a of data.archive||[])addRow(archive,[a.filename||a.media_kind,a.dest+'/'+a.dest_topic]);
  }
  async function load(){if(!app?.initData){$('status').textContent='Open this Mini App using the private Telegram bot.';return;}
    try{const response=await fetch('/mini/api',{method:'POST',headers:{'Authorization':'tma '+app.initData},cache:'no-store'});
      if(!response.ok)throw new Error(response.status===403?'Telegram identity rejected':'Mini App unavailable');
      render(await response.json());$('status').textContent='Verified owner account • read-only overview';
    }catch(error){$('status').textContent=error.message;}
  }
  $('refresh').addEventListener('click',()=>{void load();});void load();
})();`;
