// ═══════════════════════════════════════
// WebForge Pro — Plugin System (plugins.js)
// ═══════════════════════════════════════

const PLUGIN_KEY = 'webforge_plugins_v1';

// ── Plugin state ──────────────────────
let pluginState = { plugins: {}, nextId: 1 };
let pluginMonaco = null;
let pluginCurrentId = null;

// ── Runtime registries ────────────────
const _pluginCSS         = {};  // id → <style> el
const _pluginRunHooks    = {};  // id → fn(html)→html
const _pluginPreviewJS   = {};  // id → js string
const _pluginToolbar     = {};  // id → [<button>]
const _pluginSidebar     = {};  // id → [<div>]
const _pluginMenuItems   = {};  // id → [<div>]
const _pluginCommands    = {};  // id → [{label,desc,icon,fn}]
const _pluginTemplates   = {};  // id → [{label,ext,icon,color,content}]

// ════════════════════════════════════════
// PUBLIC API  (available inside plugins as `WebForge.xxx`)
// ════════════════════════════════════════
function buildAPI(id) {
  return {

    // ── Themes ───────────────────────────
    registerTheme(name, cssVars) {
      const slug = name.toLowerCase().replace(/\s+/g,'-');
      let css = `[data-theme="${slug}"]{`;
      Object.entries(cssVars).forEach(([k,v]) => { css += (k.startsWith('--')?k:'--'+k)+':'+v+';'; });
      css += '}';
      let el = document.getElementById('pt-'+slug);
      if (!el) { el = document.createElement('style'); el.id='pt-'+slug; document.head.appendChild(el); }
      el.textContent = css;
      THEMES[slug] = { bg: cssVars['--bg']||'#111', sidebar: cssVars['--sidebar']||'#111', accent: cssVars['--accent']||'#fff', label: name };
      if (document.getElementById('theme-grid')) buildThemeGrid();
    },

    // ── Languages + autocomplete ─────────
    registerLanguage(langId, label, extensions, completions=[]) {
      if (!window.monaco) return;
      if (!monaco.languages.getLanguages().find(l=>l.id===langId))
        monaco.languages.register({ id:langId, extensions });
      if (completions.length) {
        monaco.languages.registerCompletionItemProvider(langId, {
          provideCompletionItems() {
            return { suggestions: completions.map(c => ({
              label: c.label,
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: c.insertText,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: c.detail||''
            }))};
          }
        });
      }
      if (extensions) extensions.forEach(e => { EXT_LANG[e.replace('.','')]=langId; });
    },

    // ── Snippets ─────────────────────────
    registerSnippet(trigger, body, lang='javascript') {
      if (!window.monaco) return;
      monaco.languages.registerCompletionItemProvider(lang, {
        provideCompletionItems() {
          return { suggestions:[{ label:trigger, kind:monaco.languages.CompletionItemKind.Snippet, insertText:body, insertTextRules:monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail:'Snippet: '+trigger }]};
        }
      });
    },

    // ── Toolbar button ───────────────────
    addToolbarButton(label, icon, cb) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.innerHTML = `<i class="fas ${icon}"></i> ${label}`;
      btn.onclick = cb;
      const toolbar = document.querySelector('.toolbar');
      const badge = toolbar && toolbar.querySelector('.lang-badge');
      if (badge) toolbar.insertBefore(btn, badge); else toolbar && toolbar.appendChild(btn);
      if (!_pluginToolbar[id]) _pluginToolbar[id]=[];
      _pluginToolbar[id].push(btn);
    },

    // ── Sidebar panel ────────────────────
    addSidebarPanel(title, html) {
      const sidebar = document.getElementById('sidebar');
      if (!sidebar) return;
      const panel = document.createElement('div');
      panel.style.borderTop = '1px solid var(--border)';
      panel.innerHTML = `<div style="height:30px;display:flex;align-items:center;padding:0 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--accent2)">${title}</div><div style="padding:8px 10px;font-size:11px;color:var(--text-dim)">${html}</div>`;
      const footer = sidebar.querySelector('.sidebar-footer');
      footer ? sidebar.insertBefore(panel, footer) : sidebar.appendChild(panel);
      if (!_pluginSidebar[id]) _pluginSidebar[id]=[];
      _pluginSidebar[id].push(panel);
    },

    // ── View menu item ───────────────────
    addViewMenuItem(label, icon, cb) {
      const dropdown = document.getElementById('dropdown-view');
      if (!dropdown) return;
      const sep = document.createElement('div'); sep.className='dropdown-sep';
      const item = document.createElement('div');
      item.className='dropdown-item';
      item.innerHTML=`<i class="fas ${icon}"></i> ${label}`;
      item.onclick = cb;
      dropdown.appendChild(sep);
      dropdown.appendChild(item);
      if (!_pluginMenuItems[id]) _pluginMenuItems[id]=[];
      _pluginMenuItems[id].push(sep, item);
    },

    // ── Command palette entry ─────────────
    addCommand(label, desc, icon, cb) {
      if (!_pluginCommands[id]) _pluginCommands[id]=[];
      _pluginCommands[id].push({label,desc,icon:icon||'fa-puzzle-piece',fn:cb});
      _rebuildPaletteCommands();
    },

    // ── Preview run hook ─────────────────
    onRun(cb) { _pluginRunHooks[id]=cb; },

    // ── Inject CSS into the app ───────────
    injectCSS(css) {
      let el = _pluginCSS[id];
      if (!el) { el=document.createElement('style'); document.head.appendChild(el); _pluginCSS[id]=el; }
      el.textContent = css;
    },

    // ── Inject JS into every preview run ──
    injectPreviewScript(js) { _pluginPreviewJS[id]=js; },

    // ── File template in New File dialog ──
    addFileTemplate(label, ext, icon, color, content) {
      if (!_pluginTemplates[id]) _pluginTemplates[id]=[];
      _pluginTemplates[id].push({label,ext,icon,color,content});
      _rebuildTemplateGrid();
    },

    // ── Notifications ─────────────────────
    notify(msg, type='success') { showToast(msg, type); },

    // ── File access ───────────────────────
    getFiles()          { return state.files; },
    getActiveFile()     { return state.activeFile; },
    setFile(name, content) {
      const info = getFileInfo(name);
      state.files[name] = {content, language:info.lang};
      if (!state.openTabs.includes(name)) state.openTabs.push(name);
      renderFileTree(); renderTabs(); saveState();
    }
  };
}

// ════════════════════════════════════════
// CLEANUP  — remove all DOM from a plugin
// ════════════════════════════════════════
function pluginCleanup(id) {
  _pluginCSS[id]?.remove();       delete _pluginCSS[id];
  _pluginToolbar[id]?.forEach(e=>e.remove());   delete _pluginToolbar[id];
  _pluginSidebar[id]?.forEach(e=>e.remove());   delete _pluginSidebar[id];
  _pluginMenuItems[id]?.forEach(e=>e.remove()); delete _pluginMenuItems[id];
  delete _pluginRunHooks[id];
  delete _pluginPreviewJS[id];
  delete _pluginCommands[id];
  delete _pluginTemplates[id];
  _rebuildPaletteCommands();
  _rebuildTemplateGrid();
}

// ════════════════════════════════════════
// RUN A PLUGIN
// ════════════════════════════════════════
function pluginRun(id) {
  const p = pluginState.plugins[id];
  if (!p || !p.enabled || !p.code.trim()) return;
  pluginCleanup(id);
  try {
    const fn = new Function('WebForge', p.code);
    fn(buildAPI(id));
  } catch(err) {
    showToast(`Plugin "${p.name}" error: ${err.message}`, 'error');
    console.error('[Plugin]', err);
  }
}

function pluginRunAll() {
  Object.keys(pluginState.plugins).forEach(id => pluginRun(id));
  _updatePluginBadge();
}

// ════════════════════════════════════════
// PATCH runCode to support plugin hooks
// ════════════════════════════════════════
function _patchRunCode() {
  const _orig = window.runCode;
  window.runCode = function() {
    requestAnimationFrame(() => {
      let html = (state.files['index.html'] || Object.values(state.files).find(f=>f.language==='html'))?.content || '';
      if (!html) { showToast('No HTML file found','warn'); return; }

      const consoleSrc = consoleCap ? `<script>(function(){const _l=console.log,_w=console.warn,_e=console.error;function s(t,a){try{window.parent.postMessage({type:'console',level:t,msg:Array.from(a).map(x=>{try{return typeof x==='object'?JSON.stringify(x,null,2):String(x)}catch(e){return '[obj]'}}).join(' ')},'*')}catch(e){}}console.log=function(){s('log',arguments);_l.apply(console,arguments)};console.warn=function(){s('warn',arguments);_w.apply(console,arguments)};console.error=function(){s('error',arguments);_e.apply(console,arguments)};window.onerror=function(m,s,l,c){s('error',[m+' ('+l+':'+c+')'])};})();<\/script>` : '';

      Object.entries(state.files).forEach(([name,file]) => {
        if (!name.endsWith('.css')||file.isImage) return;
        const css=`<style>/* ${name} */\n${file.content}\n</style>`;
        const tag=new RegExp(`<link[^>]+href=["']${name}["'][^>]*>`,'i');
        html = tag.test(html) ? html.replace(tag,css) : html.replace('</head>',css+'\n</head>');
      });

      Object.entries(state.files).forEach(([name,file]) => {
        if ((!name.endsWith('.js')&&!name.endsWith('.ts'))||file.isImage) return;
        const js=`<script>/* ${name} */\n${file.content}\n<\/script>`;
        const tag=new RegExp(`<script[^>]+src=["']${name}["'][^>]*><\\/script>`,'i');
        if (tag.test(html)) html=html.replace(tag,js);
      });

      Object.entries(state.files).forEach(([name,file]) => {
        if (!file.isImage||!file.objectUrl) return;
        html=html.replace(new RegExp(`(src|href)=["']${name}["']`,'gi'),`$1="${file.objectUrl}"`);
      });

      // Plugin run hooks
      Object.values(_pluginRunHooks).forEach(hook => {
        try { const r=hook(html); if(typeof r==='string') html=r; } catch(e){}
      });

      // Plugin injected scripts
      const injected = Object.values(_pluginPreviewJS).map(js=>`<script>${js}<\/script>`).join('\n');

      document.getElementById('preview-frame').srcdoc = consoleSrc + injected + html;
    });
  };
}

// ════════════════════════════════════════
// PALETTE + TEMPLATE REBUILDERS
// ════════════════════════════════════════
function _rebuildPaletteCommands() {
  // Remove old plugin commands then re-add
  const pluginLabels = new Set(
    Object.values(_pluginCommands).flat().map(c=>c.label)
  );
  // Remove stale
  for (let i = COMMANDS.length-1; i>=0; i--) {
    if (COMMANDS[i]._fromPlugin) COMMANDS.splice(i,1);
  }
  Object.values(_pluginCommands).flat().forEach(c => {
    COMMANDS.push({...c, _fromPlugin:true});
  });
}

function _rebuildTemplateGrid() {
  if (!document.getElementById('template-grid')) return;
  buildTemplateGrid();
  // Add plugin templates
  const grid = document.getElementById('template-grid');
  Object.values(_pluginTemplates).flat().forEach(t => {
    const btn = document.createElement('button');
    btn.style.cssText='background:var(--panel2);border:1px solid var(--border);border-radius:6px;padding:8px 4px;cursor:pointer;color:var(--text);font-family:var(--font-ui);font-size:11px;display:flex;flex-direction:column;align-items:center;gap:4px;';
    btn.innerHTML=`<i class="fas ${t.icon||'fa-file'}" style="color:${t.color||'var(--accent)'};font-size:18px"></i>${t.label}`;
    btn.onclick=()=>{ document.getElementById('new-file-name').value='new-file.'+t.ext; };
    grid.appendChild(btn);
  });
}

// ════════════════════════════════════════
// PERSISTENCE
// ════════════════════════════════════════
function pluginSave() {
  try { localStorage.setItem(PLUGIN_KEY, JSON.stringify(pluginState)); } catch(e) {}
}

function pluginLoad() {
  try {
    const raw = localStorage.getItem(PLUGIN_KEY);
    if (raw) pluginState = JSON.parse(raw);
  } catch(e) { pluginState = {plugins:{}, nextId:1}; }
}

// ════════════════════════════════════════
// BADGE
// ════════════════════════════════════════
function _updatePluginBadge() {
  const n = Object.values(pluginState.plugins).filter(p=>p.enabled).length;
  const b = document.getElementById('plugin-badge');
  if (b) { b.textContent=n; b.style.display=n?'inline-block':'none'; }
}

// ════════════════════════════════════════
// PLUGIN MANAGER  UI
// ════════════════════════════════════════
function openPluginManager() {
  closeAllMenus();
  _renderPluginList();
  document.getElementById('pm-modal').style.display='flex';
  // init Monaco for plugin editor (lazy)
  setTimeout(_initPluginMonaco, 80);
}

function closePluginManager() {
  document.getElementById('pm-modal').style.display='none';
}

function _initPluginMonaco() {
  if (pluginMonaco || !window.monaco) return;
  pluginMonaco = monaco.editor.create(document.getElementById('pm-code'), {
    value:'', language:'javascript',
    theme: state.settings?.editorTheme==='vs-dark' ? 'webforge-dark' : (state.settings?.editorTheme||'vs-dark'),
    automaticLayout:true, fontSize:13,
    fontFamily:"'JetBrains Mono',monospace",
    minimap:{enabled:false}, wordWrap:'on',
    scrollBeyondLastLine:false, lineNumbers:'on',
    padding:{top:10,bottom:10},
    bracketPairColorization:{enabled:true},
  });
  pluginMonaco.onDidChangeModelContent(() => {
    if (pluginCurrentId && pluginState.plugins[pluginCurrentId]) {
      pluginState.plugins[pluginCurrentId].code = pluginMonaco.getValue();
      pluginSave();
    }
  });
  if (pluginCurrentId && pluginState.plugins[pluginCurrentId])
    pluginMonaco.setValue(pluginState.plugins[pluginCurrentId].code||'');
}

function _renderPluginList() {
  const el = document.getElementById('pm-list');
  el.innerHTML='';
  const ids = Object.keys(pluginState.plugins);
  if (!ids.length) {
    el.innerHTML='<div style="padding:20px;text-align:center;color:var(--text-faint);font-size:11px">No plugins yet.<br>Click + New</div>';
    return;
  }
  ids.forEach(id => {
    const p = pluginState.plugins[id];
    const sel = id===pluginCurrentId;
    const d = document.createElement('div');
    d.style.cssText=`padding:10px;border-radius:8px;cursor:pointer;border:1px solid ${sel?'var(--accent)':'transparent'};margin-bottom:4px;background:${sel?'var(--accent-glow)':'transparent'};transition:all .15s`;
    d.innerHTML=`<div style="font-size:12px;font-weight:600;margin-bottom:3px;display:flex;align-items:center;gap:6px"><span style="width:7px;height:7px;border-radius:50%;background:${p.enabled?'var(--success)':'var(--border-bright)'};flex-shrink:0"></span>${p.name||'Unnamed'}</div><div style="font-size:10px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.desc||'No description'}</div>`;
    d.onclick=()=>_selectPlugin(id);
    el.appendChild(d);
  });
}

function _selectPlugin(id) {
  pluginCurrentId = id;
  const p = pluginState.plugins[id];
  if (!p) return;
  document.getElementById('pm-empty').style.display='none';
  document.getElementById('pm-edit').style.display='flex';
  document.getElementById('pm-name').value=p.name||'';
  document.getElementById('pm-desc').value=p.desc||'';
  document.getElementById('pm-enabled').classList.toggle('on', !!p.enabled);
  if (pluginMonaco) { pluginMonaco.setValue(p.code||''); pluginMonaco.layout(); }
  _renderPluginList();
}

function pluginCreate() {
  const id = 'p_'+(pluginState.nextId++);
  pluginState.plugins[id] = {
    id, name:'New Plugin', desc:'My custom plugin', enabled:true,
    code:`// ─────────────────────────────────────────
// WebForge Plugin  —  edit me and hit Apply!
// ─────────────────────────────────────────

// EXAMPLE 1: Add a colour wheel toggle to the View menu
(function() {
  let wheelOpen = false;
  let wheelEl = null;

  function openWheel() {
    if (wheelEl) { wheelEl.remove(); wheelEl=null; wheelOpen=false; return; }
    wheelOpen = true;
    wheelEl = document.createElement('div');
    wheelEl.style.cssText = 'position:fixed;bottom:60px;right:20px;z-index:9999;background:var(--panel);border:1px solid var(--border-bright);border-radius:12px;padding:16px;box-shadow:0 8px 32px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:10px;width:200px';
    wheelEl.innerHTML = \`
      <div style="font-size:12px;font-weight:600;color:var(--text)">🎨 Colour Wheel</div>
      <input type="color" id="cw-accent" value="#6366f1" style="width:100%;height:36px;border:none;border-radius:6px;cursor:pointer;background:transparent">
      <div style="font-size:10px;color:var(--text-dim)">Pick an accent colour</div>
      <button onclick="document.documentElement.style.setProperty('--accent', document.getElementById('cw-accent').value); document.documentElement.style.setProperty('--accent-glow', document.getElementById('cw-accent').value+'44')" style="padding:6px;border-radius:6px;border:1px solid var(--border-bright);background:var(--panel2);color:var(--text);cursor:pointer;font-size:11px">Apply Colour</button>
      <button onclick="this.closest('div').remove();wheelEl=null;wheelOpen=false" style="padding:6px;border-radius:6px;border:1px solid var(--border-bright);background:transparent;color:var(--text-dim);cursor:pointer;font-size:11px">Close</button>
    \`;
    document.body.appendChild(wheelEl);
  }

  WebForge.addViewMenuItem('Colour Wheel', 'fa-palette', openWheel);
  WebForge.notify('Colour Wheel plugin loaded! Check View menu 🎨', 'success');
})();


// EXAMPLE 2: Register a custom theme
// WebForge.registerTheme('Grape', {
//   '--bg': '#0d0a1a',
//   '--sidebar': '#110d22',
//   '--panel': '#16112e',
//   '--panel2': '#1c1638',
//   '--text': '#e2d9ff',
//   '--text-dim': '#6655aa',
//   '--accent': '#9333ea',
//   '--accent-glow': 'rgba(147,51,234,0.25)',
//   '--accent2': '#c084fc',
//   '--border': '#221a44',
//   '--border-bright': '#332866',
// });


// EXAMPLE 3: Add Lua language with autocomplete
// WebForge.registerLanguage('lua', 'Lua', ['.lua'], [
//   { label: 'print',    insertText: 'print(${1:value})',                   detail: 'Print to output' },
//   { label: 'function', insertText: 'function ${1:name}(${2:args})\\n\\t$0\\nend', detail: 'Function block' },
//   { label: 'for',      insertText: 'for ${1:i}=1,${2:10} do\\n\\t$0\\nend',     detail: 'For loop' },
// ]);
`
  };
  pluginSave();
  _renderPluginList();
  _selectPlugin(id);
  _updatePluginBadge();
  showToast('Plugin created!','success');
  setTimeout(()=>{ const n=document.getElementById('pm-name'); if(n){n.focus();n.select();} },120);
}

function pluginSaveMeta() {
  if (!pluginCurrentId||!pluginState.plugins[pluginCurrentId]) return;
  pluginState.plugins[pluginCurrentId].name = document.getElementById('pm-name').value;
  pluginState.plugins[pluginCurrentId].desc = document.getElementById('pm-desc').value;
  pluginSave(); _renderPluginList();
}

function pluginToggleEnabled() {
  if (!pluginCurrentId||!pluginState.plugins[pluginCurrentId]) return;
  const btn = document.getElementById('pm-enabled');
  btn.classList.toggle('on');
  const on = btn.classList.contains('on');
  pluginState.plugins[pluginCurrentId].enabled = on;
  pluginSave(); _renderPluginList(); _updatePluginBadge();
  if (!on) pluginCleanup(pluginCurrentId);
  else pluginRun(pluginCurrentId);
}

function pluginApply() {
  if (!pluginCurrentId) return;
  if (pluginMonaco) pluginState.plugins[pluginCurrentId].code = pluginMonaco.getValue();
  pluginSave();
  pluginRun(pluginCurrentId);
  _renderPluginList();
  _updatePluginBadge();
  showToast('Plugin applied! ✨','success');
}

function pluginDelete() {
  if (!pluginCurrentId) return;
  if (!confirm('Delete this plugin?')) return;
  pluginCleanup(pluginCurrentId);
  delete pluginState.plugins[pluginCurrentId];
  pluginCurrentId = null;
  pluginSave(); _renderPluginList(); _updatePluginBadge();
  document.getElementById('pm-empty').style.display='flex';
  document.getElementById('pm-edit').style.display='none';
  showToast('Plugin deleted','warn');
}

// ════════════════════════════════════════
// BOOT
// ════════════════════════════════════════
(function boot() {
  pluginLoad();

  // Inject Plugin Manager modal + Plugins menu into the page
  _injectUI();

  // Wait for Monaco + state to be ready, then run plugins
  const tryRun = () => {
    if (window.monaco && window.editor && window.state) {
      _patchRunCode();
      pluginRunAll();
    } else {
      setTimeout(tryRun, 250);
    }
  };
  tryRun();
})();

function _injectUI() {
  // ── Plugin Manager Modal ──────────────
  const modal = document.createElement('div');
  modal.id = 'pm-modal';
  modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:none;align-items:center;justify-content:center;';
  modal.innerHTML=`
    <div style="background:var(--panel);border:1px solid var(--border-bright);border-radius:10px;width:min(900px,95vw);height:min(680px,92vh);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.6)">
      <!-- Header -->
      <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0">
        <i class="fas fa-puzzle-piece" style="color:var(--accent)"></i>
        <span style="font-size:14px;font-weight:600">Plugin Manager</span>
        <span style="font-size:10px;color:var(--text-dim)">Write JS plugins to extend the editor</span>
        <button onclick="closePluginManager()" style="margin-left:auto;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:4px;border:none;background:transparent;color:var(--text-dim);cursor:pointer;font-size:11px"><i class="fas fa-times"></i></button>
      </div>
      <!-- Body -->
      <div style="flex:1;display:flex;min-height:0;overflow:hidden">
        <!-- Left list -->
        <div style="width:210px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden">
          <div style="padding:8px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">
            <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text-dim);flex:1">Plugins</span>
            <button onclick="pluginCreate()" class="btn btn-primary" style="height:22px;padding:0 8px;font-size:10px"><i class="fas fa-plus"></i> New</button>
          </div>
          <div id="pm-list" style="flex:1;overflow-y:auto;padding:6px"></div>
        </div>
        <!-- Right editor -->
        <div style="flex:1;display:flex;flex-direction:column;min-width:0">
          <!-- Empty state -->
          <div id="pm-empty" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--text-faint)">
            <i class="fas fa-puzzle-piece" style="font-size:40px"></i>
            <p style="font-size:13px">Select a plugin or create one</p>
            <button onclick="pluginCreate()" class="btn btn-primary"><i class="fas fa-plus"></i> Create first plugin</button>
          </div>
          <!-- Edit area -->
          <div id="pm-edit" style="display:none;flex-direction:column;flex:1;min-height:0">
            <!-- Edit toolbar -->
            <div style="height:42px;border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 12px;gap:8px;flex-shrink:0;background:var(--panel2)">
              <input id="pm-name" placeholder="Plugin name…" oninput="pluginSaveMeta()" style="flex:1;background:transparent;border:none;outline:none;font-family:var(--font-ui);font-size:14px;font-weight:600;color:var(--text)">
              <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim);cursor:pointer;flex-shrink:0">
                <button class="toggle" id="pm-enabled" onclick="pluginToggleEnabled()"></button>On
              </label>
              <button onclick="pluginApply()" class="btn btn-success" style="height:24px;padding:0 10px;font-size:11px;flex-shrink:0"><i class="fas fa-play"></i> Apply</button>
              <button onclick="pluginDelete()" class="btn btn-danger" style="height:24px;padding:0 8px;font-size:11px;flex-shrink:0"><i class="fas fa-trash"></i></button>
            </div>
            <!-- Description -->
            <div style="padding:5px 12px;border-bottom:1px solid var(--border);background:var(--panel2)">
              <input id="pm-desc" placeholder="Short description…" oninput="pluginSaveMeta()" style="width:100%;padding:4px 10px;background:var(--panel);border:1px solid var(--border-bright);border-radius:6px;color:var(--text);font-family:var(--font-ui);font-size:11px;outline:none;height:26px">
            </div>
            <!-- Code editor -->
            <div id="pm-code" style="flex:1;min-height:0;position:relative"></div>
            <!-- API Docs -->
            <details style="background:var(--panel2);border-top:1px solid var(--border);max-height:160px;overflow-y:auto;flex-shrink:0">
              <summary style="padding:8px 14px;font-size:11px;font-weight:600;color:var(--accent2);cursor:pointer;user-select:none">📖 Plugin API</summary>
              <div style="padding:4px 14px 10px;font-size:10px;color:var(--text-dim);line-height:2">
                <code style="color:var(--accent2)">WebForge.registerTheme(name, cssVars)</code> — add a theme to the switcher<br>
                <code style="color:var(--accent2)">WebForge.registerLanguage(id, label, exts, completions)</code> — add a Monaco language + autocomplete<br>
                <code style="color:var(--accent2)">WebForge.registerSnippet(trigger, body, lang)</code> — add a code snippet<br>
                <code style="color:var(--accent2)">WebForge.addToolbarButton(label, icon, cb)</code> — add a toolbar button<br>
                <code style="color:var(--accent2)">WebForge.addSidebarPanel(title, html)</code> — add a sidebar panel<br>
                <code style="color:var(--accent2)">WebForge.addViewMenuItem(label, icon, cb)</code> — add item to View menu<br>
                <code style="color:var(--accent2)">WebForge.addCommand(label, desc, icon, cb)</code> — add to command palette<br>
                <code style="color:var(--accent2)">WebForge.onRun(cb)</code> — hook into preview (cb(html)→html)<br>
                <code style="color:var(--accent2)">WebForge.injectCSS(css)</code> — inject CSS into the app<br>
                <code style="color:var(--accent2)">WebForge.injectPreviewScript(js)</code> — inject JS into every preview<br>
                <code style="color:var(--accent2)">WebForge.addFileTemplate(label,ext,icon,color,content)</code> — add New File template<br>
                <code style="color:var(--accent2)">WebForge.notify(msg, type)</code> — show a toast<br>
                <code style="color:var(--accent2)">WebForge.getFiles()</code> / <code style="color:var(--accent2)">getActiveFile()</code> / <code style="color:var(--accent2)">setFile(name,content)</code>
              </div>
            </details>
          </div>
        </div>
      </div>
      <!-- Footer -->
      <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
        <span style="font-size:11px;color:var(--text-dim)">Plugins are saved automatically. Press Apply to activate changes.</span>
        <button onclick="closePluginManager()" class="btn btn-subtle">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // ── Plugins menu in menubar ───────────
  const menubar = document.querySelector('.menubar');
  const settingsItem = Array.from(menubar.querySelectorAll('.menu-item')).find(el=>el.textContent.trim()==='Settings');
  if (menubar && settingsItem) {
    const menuEl = document.createElement('div');
    menuEl.className='menu-item';
    menuEl.id='menu-plugins';
    menuEl.onclick=()=>toggleMenu('plugins');
    menuEl.innerHTML=`Plugins <span id="plugin-badge" style="background:var(--accent);color:white;font-size:9px;padding:1px 5px;border-radius:10px;margin-left:3px;display:none">0</span>
      <div class="dropdown" id="dropdown-plugins">
        <div class="dropdown-item" onclick="openPluginManager()"><i class="fas fa-puzzle-piece"></i> Plugin Manager <kbd style="margin-left:auto;font-family:var(--font-mono);font-size:10px;color:var(--text-dim);background:var(--panel2);padding:1px 5px;border-radius:3px;border:1px solid var(--border)">⌘⇧P</kbd></div>
        <div class="dropdown-item" onclick="openPluginManager();pluginCreate()"><i class="fas fa-plus"></i> New Plugin</div>
      </div>`;
    menubar.insertBefore(menuEl, settingsItem);
  }

  // ── Keyboard shortcut ─────────────────
  document.addEventListener('keydown', e => {
    if ((e.metaKey||e.ctrlKey) && e.shiftKey && e.key==='P') {
      e.preventDefault(); openPluginManager();
    }
  });
}
