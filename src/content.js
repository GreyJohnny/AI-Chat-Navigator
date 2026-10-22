(() => {
  'use strict';

  const HOST_ID = 'ai-chat-navigator-host';
  // Keep the existing key and Gemini IDs so saved titles and favorites survive.
  const STORAGE_KEY = 'geminiChatNavigatorData';
  const isDoubao = ['www.doubao.com', 'doubao.com'].includes(location.hostname);
  if (location.hostname !== 'gemini.google.com' && !isDoubao) return;
  if (isDoubao && !/^\/chat(?:\/|$)/.test(location.pathname)) return;

  const selectors = isDoubao
    ? ['[data-testid="send_message"]', '[class*="bg-g-send-msg-bubble"]']
    : [
      'user-query',
      'm-user-query',
      '[data-test-id="user-query"]',
      '[data-message-author-role="user"]',
      '[data-author="user"]',
      '.query-text'
    ];

  let data = { titles: {}, favorites: {} };
  let items = [];
  let query = '';
  let observer;
  let timer;
  let panel;
  let list;
  let search;
  let history;
  let historyButton;
  let historyStatus;

  const conversationId = () => {
    const match = location.pathname.match(isDoubao ? /^\/chat\/([^/]+)/ : /\/app\/([^/]+)/);
    const id = match ? match[1] : 'home';
    return isDoubao ? `doubao:${id}` : id;
  };

  const hash = (value) => {
    let result = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      result ^= value.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  };

  const cleanText = (value) => value.replace(/\s+/g, ' ').trim();

  function getMessageText(element) {
    if (isDoubao) {
      const textNodes = Array.from(element.querySelectorAll('[data-testid="message_text_content"]'));
      const fileNodes = Array.from(element.querySelectorAll('[data-testid="message_nested_content_file_name"]'));
      const parts = [...textNodes, ...fileNodes]
        .filter((node, index, nodes) => !nodes.some((parent, parentIndex) => parentIndex !== index && parent.contains(node)))
        .map((node) => cleanText(node.innerText || node.textContent || ''))
        .filter(Boolean);
      if (parts.length) return parts.join(' ');

      // Read only the user bubble, excluding controls and hidden accessibility text.
      const copy = element.cloneNode(true);
      copy.querySelectorAll('button, [role="button"], svg, [aria-hidden="true"]').forEach((node) => node.remove());
      return cleanText(copy.textContent || '');
    }

    const queryText = element.matches('.query-text') ? element : element.querySelector('.query-text');
    if (queryText) return cleanText(queryText.innerText || queryText.textContent || '');
    let text = cleanText(element.innerText || element.textContent || '');
    text = text.replace(/^You said\s+/i, '');
    const duplicateMatch = text.match(/^(.+)\s+\1$/);
    return duplicateMatch ? duplicateMatch[1] : text;
  }

  function getMessageBlocks() {
    const candidates = Array.from(document.querySelectorAll(selectors.join(',')))
      .filter((element) => !element.closest(`#${HOST_ID}`));

    const blocks = [];
    candidates.forEach((element) => {
      const text = getMessageText(element);
      const hasImage = Boolean(element.querySelector('img, canvas, video, [role="img"]'));
      if (!text && !hasImage) return;

      const content = text || 'Image message';
      const fingerprint = `${hash(content)}:${content.length}`;

      // A message wrapper and its nested bubble must yield a single entry.
      const nested = blocks.some((entry) => entry.element.contains(element));
      if (nested) return;
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        if (element.contains(blocks[i].element)) blocks.splice(i, 1);
      }

      blocks.push({ element, content, fingerprint });
    });

    const occurrences = new Map();
    return blocks.map((entry) => {
      const occurrence = occurrences.get(entry.fingerprint) || 0;
      occurrences.set(entry.fingerprint, occurrence + 1);
      return { ...entry, id: `${conversationId()}-${entry.fingerprint}-${occurrence}` };
    });
  }

  function makePanel() {
    if (document.getElementById(HOST_ID)) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; color-scheme: light dark; }
        * { box-sizing: border-box; }
        #panel {
          position: fixed; z-index: 2147483647; top: 14vh; right: 0;
          width: 300px; height: 72vh; min-height: 280px; max-height: 720px;
          display: flex; flex-direction: column; color: #202124;
          background: rgba(255,255,255,.97); border: 1px solid #dadce0;
          border-right: 0; border-radius: 16px 0 0 16px;
          box-shadow: 0 8px 30px rgba(0,0,0,.2);
          font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          transition: transform .22s ease;
        }
        #panel.closed { transform: translateX(100%); }
        #toggle {
          position: absolute; top: 22px; left: -88px; width: 88px; height: 42px;
          border: 0; border-radius: 12px 0 0 12px; background: #4f46e5; color: white;
          font: 700 13px system-ui; cursor: pointer; box-shadow: 0 2px 8px #0002;
        }
        header { padding: 17px 16px 8px; font-size: 15px; font-weight: 700; }
        #search { margin: 0 14px 8px; padding: 9px 11px; border: 1px solid #dadce0;
          border-radius: 9px; background: #f8f9fa; color: inherit; font: inherit; outline: none; }
        #search:focus { border-color: #4f46e5; }
        #history-tools { margin: 0 14px 8px; }
        #load-history { padding: 7px 10px; border: 1px solid #dadce0; border-radius: 8px;
          background: transparent; color: inherit; font: inherit; cursor: pointer; }
        #load-history:disabled { cursor: wait; opacity: .6; }
        #history-status { padding-top: 7px; font-size: 12px; line-height: 1.4; opacity: .8; }
        #list { overflow: auto; padding: 2px 12px 14px; }
        .item { padding: 10px 11px; margin: 6px 0; border: 1px solid #e5e7eb;
          border-radius: 10px; background: #f8f9fa; cursor: pointer; }
        .item:hover { border-color: #4f46e5; }
        .item.favorite { border-left: 4px solid #f59e0b; }
        .title { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
          overflow: hidden; overflow-wrap: anywhere; }
        .actions { display: flex; gap: 12px; justify-content: flex-end; padding-top: 6px; }
        .action { border: 0; padding: 2px 4px; color: #5f6368; background: transparent;
          font: inherit; cursor: pointer; }
        .empty { padding: 14px 10px; color: #70757a; text-align: center; }
        @media (prefers-color-scheme: dark) {
          #panel { color: #e8eaed; background: rgba(32,33,36,.98); border-color: #5f6368; }
          #search, .item { color: #e8eaed; background: #292a2d; border-color: #5f6368; }
          .action { color: #bdc1c6; }
        }
      </style>
      <section id="panel" class="closed" aria-label="AI Chat Navigator">
        <button id="toggle" type="button" aria-expanded="false">Navigator</button>
        <header>Chat Navigator</header>
        <input id="search" type="search" placeholder="Search my prompts…" autocomplete="off" aria-label="Search my prompts">
        ${isDoubao ? `<div id="history-tools">
          <button id="load-history" type="button">Load full history</button>
          <div id="history-status" role="status" aria-live="polite"></div>
        </div>` : ''}
        <div id="list" role="list"></div>
      </section>`;

    document.documentElement.appendChild(host);
    panel = shadow.getElementById('panel');
    list = shadow.getElementById('list');
    search = shadow.getElementById('search');
    historyButton = shadow.getElementById('load-history');
    historyStatus = shadow.getElementById('history-status');
    historyButton?.addEventListener('click', () => {
      if (history.busy) history.cancel();
      else history.loadAll();
    });
    const toggle = shadow.getElementById('toggle');

    toggle.addEventListener('click', () => {
      const open = panel.classList.toggle('closed') === false;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) search.focus();
    });
    search.addEventListener('input', () => {
      query = cleanText(search.value).toLocaleLowerCase();
      render();
    });
  }

  function render() {
    makePanel();
    items = history ? history.sync() : getMessageBlocks();
    if (history) {
      historyButton.textContent = history.busy ? 'Stop' : 'Load full history';
      historyButton.disabled = history.loading;
      historyStatus.textContent = history.status();
    }
    list.replaceChildren();
    const visible = items.filter((item) => {
      const title = data.titles[item.id] || item.content;
      return title.toLocaleLowerCase().includes(query) || item.content.toLocaleLowerCase().includes(query);
    });

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = items.length ? 'No matching prompts' : 'No prompts found';
      list.appendChild(empty);
      return;
    }

    visible.forEach((entry) => {
      const item = document.createElement('article');
      item.className = `item${data.favorites[entry.id] ? ' favorite' : ''}`;
      item.setAttribute('role', 'listitem');

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = data.titles[entry.id] || entry.content;
      item.appendChild(title);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const rename = document.createElement('button');
      rename.type = 'button'; rename.className = 'action'; rename.textContent = 'Rename';
      rename.setAttribute('aria-label', 'Rename');
      rename.addEventListener('click', (event) => {
        event.stopPropagation();
        const updated = window.prompt('Set a navigation title for this prompt:', data.titles[entry.id] || entry.content);
        if (updated && cleanText(updated)) {
          data.titles[entry.id] = cleanText(updated);
          save();
        }
      });

      const favorite = document.createElement('button');
      favorite.type = 'button'; favorite.className = 'action';
      favorite.textContent = data.favorites[entry.id] ? '★ Favorited' : '☆ Favorite';
      favorite.setAttribute('aria-label', data.favorites[entry.id] ? 'Remove favorite' : 'Add to favorites');
      favorite.addEventListener('click', (event) => {
        event.stopPropagation();
        if (data.favorites[entry.id]) delete data.favorites[entry.id];
        else data.favorites[entry.id] = true;
        save();
      });
      actions.append(rename, favorite);
      item.appendChild(actions);

      item.addEventListener('click', () => {
        const route = conversationId();
        if (history && history.activeId !== route) { render(); return; }
        history?.cancel();
        const highlight = (target) => {
          if (!target?.isConnected || route !== conversationId()) return;
          target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          target.classList.remove('ai-chat-nav-highlight');
          void target.offsetWidth;
          target.classList.add('ai-chat-nav-highlight');
          window.setTimeout(() => target.classList.remove('ai-chat-nav-highlight'), 2300);
        };
        const target = history ? history.findMounted(entry)
          : getMessageBlocks().find((candidate) => candidate.id === entry.id)?.element;
        if (target) highlight(target);
        else history?.locate(entry).then(highlight).catch(() => {
          if (route === conversationId()) historyStatus.textContent = 'Could not locate this prompt. Load history and try again.';
        });
      });
      list.appendChild(item);
    });
  }

  function save() {
    chrome.storage.local.set({ [STORAGE_KEY]: data }, render);
  }

  function scheduleRender() {
    clearTimeout(timer);
    timer = window.setTimeout(render, 250);
  }

  function bootstrap() {
    if (document.getElementById(HOST_ID)) return;
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const saved = result[STORAGE_KEY];
      if (saved && typeof saved === 'object') {
        data = {
          titles: saved.titles && typeof saved.titles === 'object' ? saved.titles : {},
          favorites: saved.favorites && typeof saved.favorites === 'object' ? saved.favorites : {}
        };
      }
      if (isDoubao) history = new globalThis.AIChatHistoryIndex({
        readMessages: getMessageBlocks, conversationId, onChange: render
      });
      render();
      observer = new MutationObserver((mutations) => {
        if (mutations.some((mutation) => {
          const target = mutation.target.nodeType === Node.ELEMENT_NODE
            ? mutation.target : mutation.target.parentElement;
          return !target?.closest(`#${HOST_ID}`);
        })) scheduleRender();
      });
      observer.observe(document.body, { childList: true, characterData: true, attributes: true,
        attributeFilter: ['data-message-id'], subtree: true });
      window.addEventListener('popstate', scheduleRender);
      window.addEventListener('hashchange', scheduleRender);
      // Both sites navigate with pushState, which does not dispatch popstate.
      let lastConversation = conversationId();
      window.setInterval(() => {
        const currentConversation = conversationId();
        if (currentConversation !== lastConversation) {
          lastConversation = currentConversation;
          scheduleRender();
        }
      }, 750);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  else bootstrap();
})();
