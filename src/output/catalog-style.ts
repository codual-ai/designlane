/** The catalog page's own look and its search: inline, so the page is one file that opens offline. */

export const CATALOG_CSS = `
:root{--bg:#f7f7f5;--panel:#fff;--ink:#17171b;--muted:#62626d;--line:#e3e3df;--accent:#4f46e5;--code:#f2f2ef;--warn:#9a4b00;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--panel:#1a1a1d;--ink:#ececf0;--muted:#a1a1ab;--line:#2d2d33;--accent:#9d98ff;--code:#141417;--warn:#f0a35c;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
header,main,footer{max-width:1280px;margin:0 auto;padding:0 24px}
header{padding-top:36px}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}
h1{font-size:30px;margin:6px 0 4px;letter-spacing:-.02em;overflow-wrap:anywhere}
h2{font-size:21px;margin:40px 0 4px}
h3{font-size:15px;margin:24px 0 10px;color:var(--muted);font-weight:600}
.sub{color:var(--muted);margin:0 0 16px}
.warn{color:var(--warn)}
nav{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0 0;font-size:14px}
a{color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.swatch,.style,.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;min-width:0}
.swatch{overflow:hidden}
.chip{display:flex;height:60px}.chip span{flex:1}
.meta{padding:8px 10px;font-size:12.5px;overflow-wrap:anywhere}
.meta b{display:block;font-size:13.5px}
.mono,pre,code,.tag{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.muted{color:var(--muted)}
.styles{display:flex;flex-direction:column;gap:8px}
.style{padding:10px 14px;display:flex;gap:16px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}
.style p{margin:0;overflow-wrap:anywhere;min-width:0}
.scale{display:flex;flex-direction:column;gap:6px}
.scale div{display:flex;align-items:center;gap:12px;font-size:13px}
.bar{height:12px;background:var(--accent);border-radius:3px;opacity:.75;flex:none}
.radii{display:flex;gap:16px;flex-wrap:wrap}
.radii div{text-align:center;font-size:12.5px}
.radii span{display:block;width:64px;height:64px;border:2px solid var(--accent);margin-bottom:6px;background:color-mix(in srgb,var(--accent) 10%,transparent)}
.toolbar{margin:12px 0}
.toolbar input{width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:inherit}
.filters{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.filters button{font:inherit;font-size:13px;padding:5px 11px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
.filters button[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
.card{padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.kind{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600}
.top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.name{font-weight:650;font-size:16px;overflow-wrap:anywhere}
.uses{font-size:12.5px;color:var(--muted);white-space:nowrap}
.card>.mono{overflow-wrap:anywhere}
.tags{display:flex;flex-wrap:wrap;gap:5px}
.tag{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:2px 6px;display:inline-flex;align-items:center;gap:5px;overflow-wrap:anywhere}
.tag i{width:10px;height:10px;border-radius:3px;display:inline-block;border:1px solid color-mix(in srgb,var(--ink) 20%,transparent);flex:none}
.picture{width:min(296px,100%);height:226px;margin:0 auto;overflow:hidden;border:1px solid var(--line);border-radius:10px}
.picture iframe{display:block;width:393px;height:300px;border:0;transform:scale(.7532);transform-origin:0 0}
details summary{cursor:pointer;font-size:13px;color:var(--muted)}
pre{margin:8px 0 0;max-height:320px;overflow:auto;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre}
footer{margin:48px auto 40px;color:var(--muted);font-size:12.5px}
[hidden]{display:none!important}
@media (max-width:520px){header,main,footer{padding:0 16px}.cards{grid-template-columns:1fr}}
`;

/** Search by words in a card's text, and filter by category; screens are filtered by the words only. */
export const CATALOG_SCRIPT = String.raw`
const search=document.getElementById('search');const cards=[...document.querySelectorAll('[data-text]')];const filters=[...document.querySelectorAll('[data-category-filter]')];const shown=document.getElementById('shown');let category='';
function apply(){const words=search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);let count=0;for(const card of cards){const match=words.every((w)=>card.dataset.text.includes(w))&&(!category||card.dataset.category===category||(category==='design-system'&&card.dataset.designSystem==='true')||card.dataset.kind==='screen');card.hidden=!match;if(match)count++}shown.textContent=count+' of '+cards.length+' shown'}
search.addEventListener('input',apply);
for(const button of filters)button.addEventListener('click',()=>{category=button.dataset.categoryFilter;for(const other of filters)other.setAttribute('aria-pressed',String(other===button));apply()});
apply();
`;
