(() => {
  'use strict';

  const HOST_ID = 'ai-chat-navigator-host';
  // Keep the existing key and Gemini IDs so saved titles and bookmarks survive.
  const STORAGE_KEY = 'geminiChatNavigatorData';
  const PENDING_KEY = 'aiChatNavigatorPendingTarget';
  const PENDING_TIMEOUT = 30000;
  const isDoubao = ['www.doubao.com', 'doubao.com'].includes(location.hostname);
  if (location.hostname !== 'gemini.google.com' && !isDoubao) return;
  if (isDoubao && !/^\/chat(?:\/|$)/.test(location.pathname)) return;
  const currentProvider = isDoubao ? 'doubao' : 'gemini';

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

  let data = { titles: {}, saved: {} };
  let items = [];
  let query = '';
  let savedQuery = '';
  let view = 'current';
  let pinnedOpen = false;
  let pinnedHeight = null;
  let resizeState = null;
  const savedGroupState = new Map();
  let observer;
  let timer;
  let panel;
  let list;
  let search;
  let history;
  let historyButton;
  let historyStatus;
  let currentView;
  let savedView;
  let savedButton;
  let savedCount;
  let savedSearch;
  let savedList;
  let savedStatus;
  let pinnedSection;
  let pinnedToggle;
  let pinnedCount;
  let pinnedList;
  let pinnedResizer;
  let pendingTarget = null;
  let pendingBusy = false;
  let pendingRetryTimer;
  let pendingAttempts = 0;

  const conversationId = () => {
    const match = location.pathname.match(isDoubao ? /^\/chat\/([^/]+)/ : /\/app\/([^/]+)/);
    const id = match ? match[1] : 'home';
    return isDoubao ? `doubao:${id}` : id;
  };

  const conversationUrl = () => `${location.origin}${location.pathname}`;

  function getConversationTitle() {
    const title = cleanText(document.title || '')
      .replace(/\s*[-–—|]\s*(Google Gemini|Gemini|豆包|Doubao).*$/i, '')
      .trim();
    return title || conversationId();
  }

  function providerFromId(id) {
    return id.startsWith('doubao:') ? 'doubao' : 'gemini';
  }

  function providerLabel(provider) {
    if (provider === 'doubao') return 'Doubao';
    if (provider === 'gemini') return 'Gemini';
    return provider || 'AI';
  }

  function deriveConversationFromId(id) {
    const provider = providerFromId(id);
    const base = provider === 'doubao' ? id.slice('doubao:'.length) : id;
    const match = base.match(/^(.+)-[a-z0-9]+(?::\d+)?-\d+$/);
    const rawId = match ? match[1] : base;
    const route = provider === 'doubao' ? `/chat/${rawId}` : `/app/${rawId}`;
    const origin = provider === 'doubao' ? 'https://www.doubao.com' : 'https://gemini.google.com';
    return {
      provider,
      conversationId: provider === 'doubao' ? `doubao:${rawId}` : rawId,
      conversationUrl: `${origin}${route}`
    };
  }

  const hash = (value) => {
    let result = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      result ^= value.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  };

  const cleanText = (value) => value.replace(/\s+/g, ' ').trim();

  function isTextPromptContent(content) {
    const value = cleanText(content || '');
    // Attachment nodes are excluded by getMessageText. A filename in actual
    // prompt text is still text, including a prompt consisting of "report.pdf".
    return Boolean(value) && value !== 'Image message';
  }

  function getNativeMessageId(element) {
    if (!element) return null;
    const node = element.matches('[data-message-id]') ? element
      : element.closest('[data-message-id]') || element.querySelector('[data-message-id]');
    return node?.getAttribute('data-message-id') || null;
  }

  function isSavedId(id) {
    return Boolean(data.saved[id]);
  }

  function createSavedRecord(entry) {
    return {
      id: entry.id,
      provider: currentProvider,
      conversationId: conversationId(),
      conversationUrl: conversationUrl(),
      conversationTitle: getConversationTitle(),
      title: data.titles[entry.id] || entry.content,
      content: entry.content,
      fingerprint: entry.fingerprint || null,
      hasImage: Boolean(entry.hasImage),
      nativeId: entry.nativeId || getNativeMessageId(entry.element),
      position: Number.isFinite(entry.position) ? entry.position : null,
      rowIndex: Number.isFinite(entry.rowIndex) ? entry.rowIndex : null,
      savedAt: Date.now()
    };
  }

  function legacySavedRecord(id) {
    const route = deriveConversationFromId(id);
    const title = data.titles[id] || 'Saved prompt';
    return {
      id,
      ...route,
      conversationTitle: '',
      title,
      content: title,
      fingerprint: null,
      nativeId: null,
      position: null,
      rowIndex: null,
      savedAt: 0,
      legacy: true
    };
  }

  function normalizeSavedRecord(id, value) {
    if (value === true) return legacySavedRecord(id);
    if (!value || typeof value !== 'object') return null;
    const route = deriveConversationFromId(id);
    return {
      ...route,
      ...value,
      id,
      provider: value.provider || route.provider,
      conversationId: value.conversationId || route.conversationId,
      conversationUrl: value.conversationUrl || route.conversationUrl,
      title: value.title || data.titles[id] || value.content || 'Saved prompt',
      content: value.content || value.title || 'Saved prompt'
    };
  }

  function persist(callback) {
    chrome.storage.local.set({
      [STORAGE_KEY]: { titles: data.titles, saved: data.saved }
    }, callback);
  }

  function save() {
    persist(render);
  }

  function savedRecords() {
    return Object.entries(data.saved)
      .map(([id, value]) => normalizeSavedRecord(id, value))
      .filter((record) => record && isTextPromptContent(record.content))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  function migrateLegacySaved(entries) {
    let changed = false;
    entries.forEach((entry) => {
      if (data.saved[entry.id] === true || data.saved[entry.id]?.legacy) {
        data.saved[entry.id] = createSavedRecord(entry);
        changed = true;
      } else if (data.saved[entry.id] && entry.nativeId
        && data.saved[entry.id].nativeId !== entry.nativeId) {
        data.saved[entry.id] = { ...data.saved[entry.id], nativeId: entry.nativeId,
          position: entry.position, rowIndex: entry.rowIndex };
        changed = true;
      }
    });
    if (changed) persist();
  }

  function getMessageText(element) {
    if (isDoubao) {
      const textNodes = Array.from(element.querySelectorAll('[data-testid="message_text_content"]'));
      const fileNodes = Array.from(element.querySelectorAll('[data-testid="message_nested_content_file_name"]'));
      const textParts = textNodes
        .filter((node, index, nodes) => !nodes.some((parent, parentIndex) => parentIndex !== index && parent.contains(node)))
        .map((node) => cleanText(node.innerText || node.textContent || ''))
        .filter(Boolean);
      if (textParts.length) return textParts.join(' ');
      if (fileNodes.length || element.querySelector('img, canvas, video, [role="img"]')) return '';

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

  function hasAssistantBetween(left, right, assistants) {
    return assistants.some((assistant) => (
      Boolean(left.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING)
      && Boolean(right.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_PRECEDING)
    ));
  }

  function mergeImageGroupsByTurn(groups) {
    const entries = Array.from(groups.values()).sort((left, right) => {
      if (left.element === right.element) return 0;
      return left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    const assistants = Array.from(document.querySelectorAll(
      '[data-testid="receive_message"], [class*="bg-g-receive-msg-bubble"], '
      + 'model-response, m-model-response, [data-message-author-role="assistant"], '
      + '[data-author="model"], [data-author="assistant"]'
    )).filter((node) => !node.closest(`#${HOST_ID}`));

    const runs = [];
    let run = [];
    entries.forEach((entry) => {
      if (run.length && hasAssistantBetween(run.at(-1).element, entry.element, assistants)) {
        runs.push(run);
        run = [];
      }
      run.push(entry);
    });
    if (run.length) runs.push(run);

    runs.forEach((turn) => {
      const textGroups = turn.filter((group) => group.texts.size > 0);
      const imageGroups = turn.filter((group) => group.texts.size === 0 && group.hasImage);
      if (textGroups.length !== 1 || imageGroups.length === 0
        || textGroups.length + imageGroups.length !== turn.length) return;
      const target = textGroups[0];
      imageGroups.forEach((group) => {
        target.hasImage = true;
        target.nativeId ||= group.nativeId;
        group.mergedInto = target;
      });
    });

    return entries.filter((group) => !group.mergedInto);
  }

  function getMessageBlocks() {
    const candidates = Array.from(document.querySelectorAll(selectors.join(',')))
      .filter((element) => !element.closest(`#${HOST_ID}`));
    const rootCandidates = candidates.filter((element) => !candidates.some(
      (other) => other !== element && other.contains(element)
    ));

    const groups = new Map();
    rootCandidates.forEach((element) => {
      const text = getMessageText(element);
      const hasImage = Boolean(element.querySelector('img, canvas, video, [role="img"]'));
      const nativeId = getNativeMessageId(element);
      const row = isDoubao ? element.closest('.v_list_row') : null;
      const turn = element.closest('user-query, m-user-query, [data-testid^="conversation-turn-"]');
      const groupNode = row || turn || (nativeId ? `message:${nativeId}` : element);
      let group = groups.get(groupNode);
      if (!group) {
        group = { element, groupElement: row || turn || null, texts: new Set(), hasImage: false, nativeId };
        groups.set(groupNode, group);
      }
      if (text) group.texts.add(text);
      group.hasImage ||= hasImage || Boolean(group.groupElement?.querySelector?.(
        'img, canvas, video, [role="img"]'
      ));
      group.nativeId ||= nativeId;
    });

    const mergedGroups = mergeImageGroupsByTurn(groups);
    const blocks = mergedGroups.map((group) => {
      const content = Array.from(group.texts).join(' ');
      return {
        element: group.groupElement || group.element,
        content,
        fingerprint: `${hash(content)}:${content.length}`,
        hasImage: group.hasImage,
        nativeId: group.nativeId
      };
    }).filter((block) => isTextPromptContent(block.content));

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
        [hidden] { display: none !important; }
        .header-row { display: flex; align-items: center; justify-content: space-between;
          gap: 8px; padding: 13px 14px 8px; }
        header { padding: 4px 2px; font-size: 15px; font-weight: 700; }
        #saved-button { border: 1px solid #dadce0; border-radius: 8px; padding: 6px 8px;
          background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer;
          white-space: nowrap; }
        #saved-button:hover, #saved-button[aria-pressed="true"] { border-color: #4f46e5; }
        .view { display: flex; flex-direction: column; flex: 1; min-height: 0; }
        #search, #saved-search { margin: 0 14px 8px; padding: 9px 11px; border: 1px solid #dadce0;
          border-radius: 9px; background: #f8f9fa; color: inherit; font: inherit; outline: none; }
        #search:focus, #saved-search:focus { border-color: #4f46e5; }
        #history-tools { margin: 0 14px 8px; }
        #load-history { padding: 7px 10px; border: 1px solid #dadce0; border-radius: 8px;
          background: transparent; color: inherit; font: inherit; cursor: pointer; }
        #load-history:disabled { cursor: wait; opacity: .6; }
        #history-status { padding-top: 7px; font-size: 12px; line-height: 1.4; opacity: .8; }
        #pinned-section { margin: 0 14px 8px; }
        #pinned-toggle { width: 100%; display: flex; align-items: center; gap: 7px;
          padding: 7px 9px; border: 1px solid #e5e7eb; border-radius: 9px;
          background: #f8f9fa; color: inherit; font: inherit; font-size: 13px;
          font-weight: 600; line-height: 1.3; cursor: pointer; }
        #pinned-toggle:hover { border-color: #4f46e5; }
        #pinned-count { font-weight: 400; opacity: .7; }
        .chevron { margin-left: auto; transition: transform .16s ease; }
        #pinned-toggle[aria-expanded="true"] .chevron { transform: rotate(180deg); }
        #pinned-list { display: flex; flex-direction: column; max-height: 220px; overflow: auto;
          padding-top: 2px; }
        #pinned-resizer { position: relative; height: 12px; margin: 1px 0 2px;
          cursor: ns-resize; touch-action: none; outline: none; }
        #pinned-resizer::before { content: ""; position: absolute; left: 0; right: 0; top: 5px;
          height: 1px; background: #dadce0; }
        #pinned-resizer::after { content: ""; position: absolute; left: calc(50% - 18px); top: 3px;
          width: 36px; height: 5px; border-radius: 999px; background: #c7c9ce; }
        #pinned-resizer:hover::after, #pinned-resizer:focus-visible::after { background: #4f46e5; }
        #list, #saved-list { overflow: auto; padding: 2px 12px 14px; min-height: 0; }
        #list { display: flex; flex-direction: column; flex: 1; }
        .item { padding: 10px 11px; margin: 6px 0; border: 1px solid #e5e7eb;
          border-radius: 10px; background: #f8f9fa; cursor: pointer; }
        .item:hover { border-color: #4f46e5; }
        .item.favorite { border-left: 4px solid #f59e0b; }
        .title, .pinned-title { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
          overflow: hidden; overflow-wrap: anywhere; }
        .actions { display: flex; gap: 12px; justify-content: flex-end; padding-top: 6px; }
        .action { border: 1px solid transparent; border-radius: 7px; padding: 4px 7px;
          font: inherit; font-size: 12px; line-height: 1.25; cursor: pointer; }
        .rename-action { color: #475569; background: #eef1f5; border-color: #d9dde5; }
        .rename-action:hover { background: #e3e7ee; }
        .pin-save-action { color: #4338ca; background: #eef2ff; border-color: #c7d2fe; }
        .pin-save-action:hover { background: #e0e7ff; }
        .pin-save-action[aria-pressed="true"] {
          color: #92400e; background: #fef3c7; border-color: #f59e0b;
        }
        .empty { padding: 14px 10px; color: #70757a; text-align: center; }
        .saved-toolbar { display: flex; align-items: center; gap: 10px; padding: 0 14px 9px; }
        #saved-back { border: 0; background: transparent; color: #4f46e5; font: inherit; cursor: pointer; }
        #saved-status { padding: 0 14px 7px; min-height: 17px; font-size: 12px; opacity: .8; }
        .saved-group { margin: 0 0 10px; }
        .saved-group-toggle { width: 100%; display: flex; align-items: center; justify-content: space-between;
          gap: 8px; margin: 4px 0 6px; padding: 6px 8px; border: 0; border-radius: 7px;
          background: #f1f3f6; color: inherit; font: inherit; font-size: 12px;
          font-weight: 700; letter-spacing: .04em; text-transform: uppercase; cursor: pointer; }
        .saved-group-toggle:hover { background: #e8ebf0; }
        .saved-group-toggle .chevron { margin-left: 0; }
        .saved-item { display: block; width: 100%; margin: 6px 0; padding: 10px 11px;
          border: 1px solid #e5e7eb; border-radius: 10px; background: #f8f9fa;
          color: inherit; font: inherit; text-align: left; cursor: pointer; }
        .saved-item:hover { border-color: #4f46e5; }
        .saved-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
          overflow: hidden; overflow-wrap: anywhere; }
        .saved-meta { margin-top: 4px; color: #70757a; font-size: 12px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        @media (prefers-color-scheme: dark) {
          #panel { color: #e8eaed; background: rgba(32,33,36,.98); border-color: #5f6368; }
          #search, #saved-search, #saved-button, #pinned-toggle, .item, .saved-item {
            color: #e8eaed; background: #292a2d; border-color: #5f6368;
          }
          #pinned-resizer::before { background: #5f6368; }
          #pinned-resizer::after { background: #8b8f95; }
          .rename-action { color: #d5d8dd; background: #36383c; border-color: #51545a; }
          .rename-action:hover { background: #404349; }
          .pin-save-action { color: #c7d2fe; background: #31345c; border-color: #4f5b9e; }
          .pin-save-action:hover { background: #383d6b; }
          .pin-save-action[aria-pressed="true"] {
            color: #fde68a; background: #4a3513; border-color: #b7791f;
          }
          .saved-group-toggle { background: #34363a; }
          .saved-group-toggle:hover { background: #3d4045; }
          .saved-meta { color: #bdc1c6; }
        }
      </style>
      <section id="panel" class="closed" aria-label="AI Chat Navigator">
        <button id="toggle" type="button" aria-expanded="false">Navigator</button>
        <div class="header-row">
          <header>Chat Navigator</header>
          <button id="saved-button" type="button" aria-label="Open saved prompts" aria-pressed="false">
            <span aria-hidden="true">🔖</span> Saved <span id="saved-count">0</span>
          </button>
        </div>
        <div id="current-view" class="view">
          <input id="search" type="search" placeholder="Search my prompts…" autocomplete="off" aria-label="Search my prompts">
          <div id="history-tools">
            <button id="load-history" type="button">Load full history</button>
            <div id="history-status" role="status" aria-live="polite"></div>
          </div>
          <div id="pinned-section" hidden>
            <button id="pinned-toggle" type="button" aria-expanded="false">
              <span aria-hidden="true">📌</span>
              <span>Pinned</span>
              <span id="pinned-count"></span>
              <span class="chevron" aria-hidden="true">⌄</span>
            </button>
            <div id="pinned-list" role="list" hidden></div>
            <div id="pinned-resizer" role="separator" aria-label="Resize pinned prompts"
              aria-orientation="horizontal" tabindex="0" hidden></div>
          </div>
          <div id="list" role="list"></div>
        </div>
        <div id="saved-view" class="view" hidden>
          <div class="saved-toolbar">
            <button id="saved-back" type="button">← Back</button>
            <strong>Saved</strong>
          </div>
          <input id="saved-search" type="search" placeholder="Search saved prompts…"
            autocomplete="off" aria-label="Search saved prompts">
          <div id="saved-status" role="status" aria-live="polite"></div>
          <div id="saved-list" role="list"></div>
        </div>
      </section>`;

    document.documentElement.appendChild(host);
    panel = shadow.getElementById('panel');
    list = shadow.getElementById('list');
    search = shadow.getElementById('search');
    historyButton = shadow.getElementById('load-history');
    historyStatus = shadow.getElementById('history-status');
    currentView = shadow.getElementById('current-view');
    savedView = shadow.getElementById('saved-view');
    savedButton = shadow.getElementById('saved-button');
    savedCount = shadow.getElementById('saved-count');
    savedSearch = shadow.getElementById('saved-search');
    savedList = shadow.getElementById('saved-list');
    savedStatus = shadow.getElementById('saved-status');
    pinnedSection = shadow.getElementById('pinned-section');
    pinnedToggle = shadow.getElementById('pinned-toggle');
    pinnedCount = shadow.getElementById('pinned-count');
    pinnedList = shadow.getElementById('pinned-list');
    pinnedResizer = shadow.getElementById('pinned-resizer');
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
    pinnedToggle.addEventListener('click', () => {
      pinnedOpen = !pinnedOpen;
      render();
    });
    pinnedResizer.addEventListener('pointerdown', startPinnedResize);
    pinnedResizer.addEventListener('pointermove', movePinnedResize);
    pinnedResizer.addEventListener('pointerup', endPinnedResize);
    pinnedResizer.addEventListener('pointercancel', endPinnedResize);
    pinnedResizer.addEventListener('keydown', resizePinnedWithKeyboard);
    savedButton.addEventListener('click', showSavedView);
    shadow.getElementById('saved-back').addEventListener('click', showCurrentView);
    savedSearch.addEventListener('input', () => {
      savedQuery = cleanText(savedSearch.value).toLocaleLowerCase();
      renderSavedItems();
    });
  }

  function matchesQuery(entry) {
    const title = data.titles[entry.id] || entry.content;
    return title.toLocaleLowerCase().includes(query) || entry.content.toLocaleLowerCase().includes(query);
  }

  function samePromptPosition(left, right) {
    if (left.rowIndex !== null && right.rowIndex !== null) return left.rowIndex === right.rowIndex;
    if (Number.isFinite(left.position) && Number.isFinite(right.position)) {
      return Math.abs(left.position - right.position) <= 24;
    }
    return Boolean(left.element && left.element === right.element);
  }

  function dedupeHistoryItems(entries) {
    const acceptedWithoutNativeId = [];
    return entries.filter((entry) => {
      if (entry.nativeId) return true;
      const promotedCopy = entries.some((candidate) => (
        candidate.nativeId
        && candidate.content === entry.content
        && samePromptPosition(candidate, entry)
      ));
      const repeatedElement = acceptedWithoutNativeId.some((candidate) => (
        candidate.element && candidate.element === entry.element
        && candidate.content === entry.content
        && samePromptPosition(candidate, entry)
      ));
      if (promotedCopy || repeatedElement) return false;
      acceptedWithoutNativeId.push(entry);
      return true;
    });
  }

  function appendEmpty(container, message) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = message;
    container.appendChild(empty);
  }

  function recordMatchesEntry(record, entry) {
    if (!record || !entry) return false;
    if (record.id && record.id === entry.id) return true;
    const nativeId = entry.nativeId || getNativeMessageId(entry.element);
    if (record.nativeId && nativeId === record.nativeId) return true;
    return false;
  }

  function highlightTarget(target, route = conversationId()) {
    if (!target?.isConnected || route !== conversationId()) return false;
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    target.classList.remove('ai-chat-nav-highlight');
    void target.offsetWidth;
    target.classList.add('ai-chat-nav-highlight');
    window.setTimeout(() => target.classList.remove('ai-chat-nav-highlight'), 2300);
    return true;
  }

  async function focusRecord(record) {
    const route = conversationId();
    if (record.conversationId && record.conversationId !== route) return false;
    history?.cancel();
    const current = items.find((entry) => recordMatchesEntry(record, entry));
    const currentNativeId = getNativeMessageId(current?.element);
    let target = current?.element?.isConnected
      && (!current.nativeId || currentNativeId === current.nativeId) ? current.element : null;
    if (!target && history) target = history.findMounted(record);
    if (!target && history) target = await history.locate(record);
    if (target) return highlightTarget(target, route);
    if (route === conversationId() && !history?.state?.message) {
      historyStatus.textContent = 'Could not locate this prompt. Load history and try again.';
    }
    return false;
  }

  function pinnedHeightLimits() {
    const available = currentView?.clientHeight || 480;
    return { min: 64, max: Math.max(64, available - 170) };
  }

  function setPinnedHeight(value) {
    const { min, max } = pinnedHeightLimits();
    pinnedHeight = Math.max(min, Math.min(value, max));
    pinnedList.style.height = `${pinnedHeight}px`;
    pinnedList.style.maxHeight = 'none';
    pinnedResizer.setAttribute('aria-valuemin', String(min));
    pinnedResizer.setAttribute('aria-valuemax', String(max));
    pinnedResizer.setAttribute('aria-valuenow', String(Math.round(pinnedHeight)));
  }

  function startPinnedResize(event) {
    if (event.button !== 0) return;
    resizeState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: pinnedList.getBoundingClientRect().height
    };
    pinnedResizer.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function movePinnedResize(event) {
    if (!resizeState || event.pointerId !== resizeState.pointerId) return;
    setPinnedHeight(resizeState.startHeight + event.clientY - resizeState.startY);
    event.preventDefault();
  }

  function endPinnedResize(event) {
    if (!resizeState) return;
    if (pinnedResizer.hasPointerCapture?.(resizeState.pointerId)) {
      pinnedResizer.releasePointerCapture(resizeState.pointerId);
    }
    resizeState = null;
  }

  function resizePinnedWithKeyboard(event) {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = pinnedList.getBoundingClientRect().height;
    const { min, max } = pinnedHeightLimits();
    if (event.key === 'Home') setPinnedHeight(min);
    else if (event.key === 'End') setPinnedHeight(max);
    else setPinnedHeight(current + (event.key === 'ArrowDown' ? 16 : -16));
  }

  function renderItem(entry, container, { pinned = false, visualIndex = 0, visualCount = 1 } = {}) {
    const item = document.createElement('article');
    const saved = isSavedId(entry.id);
    item.className = `item${saved ? ' favorite' : ''}`;
    item.style.order = String(visualCount - visualIndex);
    item.setAttribute('role', 'listitem');
    item.dataset.promptId = entry.id;

    const title = document.createElement('div');
    title.className = pinned ? 'pinned-title' : 'title';
    title.textContent = data.titles[entry.id] || entry.content;
    item.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const rename = document.createElement('button');
    rename.type = 'button'; rename.className = 'action rename-action'; rename.textContent = 'Rename';
    rename.setAttribute('aria-label', 'Rename');
    rename.addEventListener('click', (event) => {
      event.stopPropagation();
      const updated = window.prompt('Set a navigation title for this prompt:', data.titles[entry.id] || entry.content);
      if (updated && cleanText(updated)) {
        const nextTitle = cleanText(updated);
        data.titles[entry.id] = nextTitle;
        if (data.saved[entry.id] && typeof data.saved[entry.id] === 'object') {
          data.saved[entry.id].title = nextTitle;
        }
        save();
      }
    });

    const pinSave = document.createElement('button');
    pinSave.type = 'button';
    pinSave.className = 'action pin-save-action';
    pinSave.textContent = saved ? '✓ Pinned & Saved' : '📌 Pin & Save';
    // Keep the old accessible labels so existing shortcuts and saved UI remain compatible.
    pinSave.setAttribute('aria-label', saved ? 'Remove favorite' : 'Add to favorites');
    pinSave.setAttribute('aria-pressed', String(saved));
    pinSave.title = saved ? 'Remove from Pinned and Saved' : 'Pin in this chat and save across chats';
    pinSave.addEventListener('click', (event) => {
      event.stopPropagation();
      if (saved) delete data.saved[entry.id];
      else data.saved[entry.id] = createSavedRecord(entry);
      save();
    });
    actions.append(rename, pinSave);
    item.appendChild(actions);

    item.addEventListener('click', async () => {
      if (history && history.activeId !== conversationId()) {
        render();
        return;
      }
      await focusRecord(entry);
    });
    container.appendChild(item);
  }

  function renderSavedItems() {
    if (!savedList) return;
    const records = savedRecords();
    savedCount.textContent = String(records.length);
    savedList.replaceChildren();

    const filtered = records.filter((record) => {
      const title = data.titles[record.id] || record.title || record.content;
      const meta = `${providerLabel(record.provider)} ${record.conversationTitle || ''}`;
      return `${title} ${record.content || ''} ${meta}`.toLocaleLowerCase().includes(savedQuery);
    });

    if (!filtered.length) {
      appendEmpty(savedList, records.length ? 'No matching saved prompts' : 'No saved prompts');
      return;
    }

    const groups = new Map();
    filtered.forEach((record) => {
      const provider = record.provider || 'ai';
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider).push(record);
    });
    const ordered = Array.from(groups.entries()).sort(([left], [right]) => {
      if (left === currentProvider && right !== currentProvider) return -1;
      if (right === currentProvider && left !== currentProvider) return 1;
      return providerLabel(left).localeCompare(providerLabel(right));
    });

    ordered.forEach(([provider, group]) => {
      const section = document.createElement('div');
      section.className = 'saved-group';
      const defaultOpen = provider === currentProvider || ordered.length === 1;
      const open = Boolean(savedQuery)
        || (savedGroupState.has(provider) ? savedGroupState.get(provider) : defaultOpen);
      const heading = document.createElement('button');
      heading.type = 'button';
      heading.className = 'saved-group-toggle';
      heading.setAttribute('aria-expanded', String(open));
      const headingLabel = document.createElement('span');
      headingLabel.textContent = `${providerLabel(provider)} (${group.length})`;
      const chevron = document.createElement('span');
      chevron.className = 'chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '⌄';
      if (open) chevron.style.transform = 'rotate(180deg)';
      heading.append(headingLabel, chevron);
      heading.addEventListener('click', () => {
        savedGroupState.set(provider, !open);
        renderSavedItems();
      });
      section.appendChild(heading);

      const groupItems = document.createElement('div');
      groupItems.hidden = !open;
      group.forEach((record) => {
        const savedItem = document.createElement('button');
        savedItem.type = 'button';
        savedItem.className = 'saved-item';
        savedItem.setAttribute('role', 'listitem');

        const savedTitle = document.createElement('div');
        savedTitle.className = 'saved-title';
        savedTitle.textContent = data.titles[record.id] || record.title || record.content;
        const meta = document.createElement('div');
        meta.className = 'saved-meta';
        meta.textContent = `${providerLabel(record.provider)} · ${record.conversationTitle || 'Conversation'}`;
        savedItem.append(savedTitle, meta);
        savedItem.addEventListener('click', () => openSavedRecord(record));
        groupItems.appendChild(savedItem);
      });
      section.appendChild(groupItems);
      savedList.appendChild(section);
    });
  }

  function render() {
    makePanel();
    items = history ? dedupeHistoryItems(history.sync()) : getMessageBlocks();
    migrateLegacySaved(items);
    if (history) {
      historyButton.textContent = history.busy ? 'Stop' : 'Load full history';
      historyButton.disabled = history.loading;
      historyStatus.textContent = history.status();
    }

    currentView.hidden = view !== 'current';
    savedView.hidden = view !== 'saved';
    savedButton.setAttribute('aria-pressed', String(view === 'saved'));
    savedCount.textContent = String(savedRecords().length);

    const currentItems = items.filter(matchesQuery);
    const pinnedAll = items.filter((entry) => isSavedId(entry.id));
    const pinned = pinnedAll.filter(matchesQuery);
    const showPinned = pinnedOpen;

    pinnedSection.hidden = pinnedAll.length === 0;
    pinnedToggle.setAttribute('aria-expanded', String(showPinned));
    pinnedCount.textContent = `(${pinnedAll.length})`;
    pinnedList.hidden = !showPinned;
    pinnedResizer.hidden = !showPinned;
    if (showPinned) {
      const { min, max } = pinnedHeightLimits();
      pinnedResizer.setAttribute('aria-valuemin', String(min));
      pinnedResizer.setAttribute('aria-valuemax', String(max));
      pinnedResizer.setAttribute('aria-valuenow', String(Math.round(pinnedHeight || min)));
    }
    pinnedList.replaceChildren();
    pinned.forEach((entry, index) => renderItem(entry, pinnedList, {
      pinned: true, visualIndex: index, visualCount: pinned.length
    }));

    list.replaceChildren();
    currentItems.forEach((entry, index) => renderItem(entry, list, {
      visualIndex: index, visualCount: currentItems.length
    }));
    if (!currentItems.length) {
      appendEmpty(list, items.length ? 'No matching prompts' : 'No prompts found');
    }
    if (pinnedHeight !== null && showPinned) setPinnedHeight(pinnedHeight);

    renderSavedItems();
    maybeResolvePendingTarget();
  }

  function showSavedView() {
    view = 'saved';
    currentView.hidden = true;
    savedView.hidden = false;
    savedButton.setAttribute('aria-pressed', 'true');
    savedStatus.textContent = '';
    renderSavedItems();
    savedSearch.focus();
  }

  function showCurrentView() {
    view = 'current';
    currentView.hidden = false;
    savedView.hidden = true;
    savedButton.setAttribute('aria-pressed', 'false');
  }

  function openSavedRecord(record) {
    if (record.conversationId === conversationId()) {
      showCurrentView();
      focusRecord(record);
      return;
    }
    if (!record.conversationUrl) {
      savedStatus.textContent = 'This saved prompt does not have a valid conversation URL.';
      return;
    }
    const pending = { ...record, pendingAt: Date.now() };
    savedStatus.textContent = 'Opening saved prompt…';
    chrome.storage.local.set({ [PENDING_KEY]: pending }, () => {
      window.location.assign(record.conversationUrl);
    });
  }

  function clearPendingTarget() {
    pendingTarget = null;
    pendingAttempts = 0;
    window.clearTimeout(pendingRetryTimer);
    chrome.storage.local.remove?.(PENDING_KEY);
  }

  function retryPendingTarget() {
    if (!pendingTarget) return;
    if (Date.now() - pendingTarget.pendingAt >= PENDING_TIMEOUT || pendingAttempts >= 60) {
      const message = 'Could not locate the saved prompt before the timeout. Try Load full history.';
      if (history?.state) history.state.message = message;
      historyStatus.textContent = message;
      clearPendingTarget();
      return;
    }
    historyStatus.textContent = 'Waiting for the saved conversation to load…';
    pendingAttempts += 1;
    window.clearTimeout(pendingRetryTimer);
    pendingRetryTimer = window.setTimeout(render, 500);
  }

  function maybeResolvePendingTarget() {
    if (!pendingTarget || pendingBusy) return;
    if (pendingTarget.conversationId !== conversationId()) {
      retryPendingTarget();
      return;
    }
    panel.classList.remove('closed');
    panel.querySelector('#toggle').setAttribute('aria-expanded', 'true');
    // Cached entries can arrive before the page hydrates its message list.
    // A mounted target needs no scroll container; an unloaded target does.
    const mounted = history?.findMounted(pendingTarget);
    const scroller = history?.getScroller();
    if (!items.length || history?.loading || history?.state?.pendingSignature
      || (!mounted && (!scroller || scroller.clientHeight <= 0))) {
      retryPendingTarget();
      return;
    }
    if (Date.now() - pendingTarget.pendingAt >= PENDING_TIMEOUT) {
      retryPendingTarget();
      return;
    }

    pendingBusy = true;
    const target = pendingTarget;
    focusRecord(target).catch(() => false).then((found) => {
      pendingBusy = false;
      if (pendingTarget !== target) return;
      if (found || conversationId() !== target.conversationId) clearPendingTarget();
      else retryPendingTarget();
    });
  }

  function scheduleRender() {
    clearTimeout(timer);
    timer = window.setTimeout(render, 250);
  }

  function bootstrap() {
    if (document.getElementById(HOST_ID)) return;
    chrome.storage.local.get([STORAGE_KEY, PENDING_KEY], (result) => {
      const saved = result[STORAGE_KEY];
      if (saved && typeof saved === 'object') {
        data = {
          titles: saved.titles && typeof saved.titles === 'object' ? saved.titles : {},
          saved: {}
        };
        const savedValues = saved.saved && typeof saved.saved === 'object'
          ? saved.saved
          : saved.favorites && typeof saved.favorites === 'object' ? saved.favorites : {};
        Object.entries(savedValues).forEach(([id, value]) => {
          const record = normalizeSavedRecord(id, value);
          if (record) data.saved[id] = record;
        });
      }
      const pending = result[PENDING_KEY];
      if (pending && typeof pending === 'object' && pending.conversationId) {
        pendingTarget = { ...pending, pendingAt: Number(pending.pendingAt) || Date.now() };
      }
      history = new globalThis.AIChatHistoryIndex({
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
      window.addEventListener('resize', () => {
        if (pinnedHeight !== null && !pinnedList.hidden) setPinnedHeight(pinnedHeight);
      });
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
