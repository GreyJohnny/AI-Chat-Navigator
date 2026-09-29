(() => {
  'use strict';

  const HOST_ID = 'gemini-chat-navigator-host';
  const STORAGE_KEY = 'geminiChatNavigatorData';
  const SELECTORS = [
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

  const conversationId = () => {
    const match = location.pathname.match(/\/app\/([^/?]+)/);
    return match ? match[1] : 'home';
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

  function getMessageBlocks() {
    const candidates = Array.from(document.querySelectorAll(SELECTORS.join(',')))
      .filter((element) => !element.closest(`#${HOST_ID}`));

    const blocks = [];
    const occurrences = new Map();
    candidates.forEach((element) => {
      let text = cleanText(element.innerText || element.textContent || '');
      text = text.replace(/^You said\s+/i, '');
      const middle = Math.floor(text.length / 2);
      for (let offset = -2; offset <= 2; offset += 1) {
        const split = middle + offset;
        if (split > 0 && split < text.length && /\s/.test(text[split])) {
          const first = cleanText(text.slice(0, split));
          const second = cleanText(text.slice(split + 1));
          if (first && first === second) {
            text = first;
            break;
          }
        }
      }
      const duplicateMatch = text.match(/^(.+)\s+\1$/);
      if (duplicateMatch) text = duplicateMatch[1];
      const hasImage = Boolean(element.querySelector('img, canvas, video, [role="img"]'));
      if (!text && !hasImage) return;

      const content = text || 'Image message';
      const fingerprint = `${hash(content)}:${content.length}`;

      // Prefer the outer Gemini user-query block when both it and one of its
      // nested text nodes match a selector.
      const nested = blocks.some((entry) => entry.element.contains(element));
      if (nested) return;
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        if (element.contains(blocks[i].element)) blocks.splice(i, 1);
      }

      const occurrence = occurrences.get(fingerprint) || 0;
      occurrences.set(fingerprint, occurrence + 1);
      blocks.push({ element, content, fingerprint, occurrence });
    });

    return blocks.map((entry) => ({
      ...entry,
      id: `${conversationId()}-${entry.fingerprint}-${entry.occurrence}`
    }));
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
          position: absolute; top: 22px; left: -48px; width: 48px; height: 42px;
          border: 0; border-radius: 12px 0 0 12px; background: #4f46e5; color: white;
          font: 700 13px system-ui; cursor: pointer; box-shadow: 0 2px 8px #0002;
        }
        header { padding: 17px 16px 8px; font-size: 15px; font-weight: 700; }
        #search { margin: 0 14px 8px; padding: 9px 11px; border: 1px solid #dadce0;
          border-radius: 9px; background: #f8f9fa; color: inherit; font: inherit; outline: none; }
        #search:focus { border-color: #4f46e5; }
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
      <section id="panel" class="closed" aria-label="Gemini Chat Navigator">
        <button id="toggle" type="button" aria-expanded="false">Navigator</button>
        <header>Chat Navigator</header>
        <input id="search" type="search" placeholder="Search my prompts…" autocomplete="off" aria-label="Search my prompts">
        <div id="list" role="list"></div>
      </section>`;

    document.documentElement.appendChild(host);
    panel = shadow.getElementById('panel');
    list = shadow.getElementById('list');
    search = shadow.getElementById('search');
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
    items = getMessageBlocks();
    list.replaceChildren();
    const visible = items.filter((item) => {
      const title = data.titles[item.id] || item.content;
      return title.toLocaleLowerCase().includes(query);
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
        const target = entry.element.isConnected
          ? entry.element
          : getMessageBlocks().find((candidate) => candidate.id === entry.id)?.element;
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        target.classList.remove('gemini-chat-nav-highlight');
        void target.offsetWidth;
        target.classList.add('gemini-chat-nav-highlight');
        window.setTimeout(() => target.classList.remove('gemini-chat-nav-highlight'), 2300);
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
      render();
      observer = new MutationObserver((mutations) => {
        if (mutations.some((mutation) => {
          const changed = [...mutation.addedNodes, ...mutation.removedNodes];
          return changed.some((node) => node.nodeType === Node.ELEMENT_NODE && !node.closest?.(`#${HOST_ID}`));
        })) scheduleRender();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('popstate', scheduleRender);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  else bootstrap();
})();
