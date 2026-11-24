import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
const historySource = readFileSync(new URL('../src/history.js', import.meta.url), 'utf8');
const storageKey = 'geminiChatNavigatorData';

async function mount(t, { html = '', url = 'https://www.doubao.com/chat/123', saved = {}, setup } = {}) {
  const dom = new JSDOM(`<body>${html}</body>`, { url, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const storage = structuredClone(saved);
  const jumps = [];
  window.chrome = { storage: { local: {
    get(keys, callback) { callback(structuredClone(storage)); },
    set(values, callback) { Object.assign(storage, structuredClone(values)); callback?.(); },
    remove(keys, callback) { for (const key of [].concat(keys)) delete storage[key]; callback?.(); }
  } } };
  window.Element.prototype.scrollIntoView = function (options) { jumps.push({ element: this, options }); };
  await new Promise((resolve) => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  window.eval(historySource);
  setup?.(window);
  window.eval(source);
  const shadow = window.document.getElementById('ai-chat-navigator-host')?.shadowRoot;
  const titles = () => Array.from(shadow?.querySelectorAll('.title') || [], (node) => node.textContent);
  const search = (value) => {
    const input = shadow.getElementById('search');
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  return { window, shadow, storage, jumps, titles, search };
}

async function eventually(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('The navigation panel did not update');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('Doubao indexes user prompts once and excludes assistant messages and sidebar text', async (t) => {
  const app = await mount(t, { html: `
    <aside>History and sidebar noise</aside>
    <div data-testid="send_message" id="first">
      <div class="bg-g-send-msg-bubble"><div data-testid="message_text_content">First question</div></div>
      <button>Copy</button>
    </div>
    <div data-testid="receive_message"><div data-testid="message_text_content">Assistant answer</div></div>
    <div class="bg-g-receive-msg-bubble">Another assistant answer</div>
    <div class="bg-g-send-msg-bubble" id="second">hello hello<button>Copy</button></div>
  ` });
  assert.deepEqual(app.titles(), ['First question', 'hello hello']);
  app.shadow.getElementById('toggle').click();
  assert.equal(app.shadow.getElementById('toggle').getAttribute('aria-expanded'), 'true');
  app.search('HELLO');
  assert.deepEqual(app.titles(), ['hello hello']);
  app.shadow.querySelector('.item').click();
  assert.equal(app.jumps[0].element.id, 'second');
  assert.equal(app.jumps[0].options.block, 'center');
  assert.ok(app.jumps[0].element.classList.contains('ai-chat-nav-highlight'));
  app.search('missing');
  assert.equal(app.shadow.querySelector('.empty').textContent, 'No matching prompts');
});

test('hovering a prompt shows the full content in a tooltip', async (t) => {
  const prompt = 'A long prompt that should be available in full inside the compact hover tooltip without changing the sidebar title.';
  const app = await mount(t, { html: `<div data-testid="send_message">${prompt}</div>` });
  const item = app.shadow.querySelector('.item');
  const tooltip = app.shadow.getElementById('prompt-tooltip');
  assert.equal(tooltip.hidden, true);
  item.dispatchEvent(new app.window.Event('mouseenter'));
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent, prompt);
  item.dispatchEvent(new app.window.Event('mouseleave'));
  tooltip.dispatchEvent(new app.window.Event('mouseenter'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(tooltip.hidden, false);
  tooltip.dispatchEvent(new app.window.Event('mouseleave'));
  await eventually(() => tooltip.hidden);
});

test('Doubao indexes images and text without file attachment filenames', async (t) => {
  const app = await mount(t, { html: `
    <div data-testid="send_message">
      <div data-testid="message_text_content">Explain this file</div>
      <div data-testid="message_nested_content_file_name">notes.pdf</div><button>Download</button>
    </div>
    <div data-testid="send_message"><img src="data:image/png;base64," alt="Uploaded image"></div>
    <div data-testid="send_message"><div data-testid="message_nested_content_file_name">report.txt</div></div>
  ` });
  assert.deepEqual(app.titles(), ['Explain this file', 'Image 1']);
});

test('separate image submissions remain separate and mixed prompts merge within their own row', async (t) => {
  const app = await mount(t, { html: `
    <div class="v_list_row" id="photo"><div data-testid="send_message" data-message-id="photo"><button><span role="img"><img src="photo.png"></span></button></div></div>
    <div class="v_list_row" id="gallery"><div data-testid="send_message" data-message-id="gallery"><img src="one.png"><img src="two.png"></div></div>
    <div class="v_list_row" id="mixed">
      <div data-testid="send_message" data-message-id="mixed"><img src="mixed.png"></div>
      <div data-testid="send_message" data-message-id="mixed"><div data-testid="message_text_content">Explain the diagram</div></div>
    </div>
    <div data-testid="receive_message"><img src="answer.png"></div>
  ` });
  assert.deepEqual(app.titles(), ['Image 1', 'Image 2 (2 images)', 'Explain the diagram']);
  for (const [index, id] of ['photo', 'gallery', 'mixed'].entries()) {
    app.shadow.querySelectorAll('.item')[index].click();
    await eventually(() => app.jumps.length > index);
    assert.equal(app.jumps.at(-1).element.id, id);
    assert.equal(app.jumps.at(-1).options.behavior, 'smooth');
  }
  app.window.prompt = () => 'My diagram';
  app.shadow.querySelectorAll('[aria-label="Rename"]')[2].click();
  app.shadow.querySelectorAll('[aria-label="Add to favorites"]')[2].click();
  const record = Object.values(app.storage[storageKey].saved)[0];
  assert.equal(record.hasImage, true);
  assert.equal(record.imageCount, 1);
});

test('Gemini image-only and mixed prompts exclude accessibility labels and assistant images', async (t) => {
  const app = await mount(t, { url: 'https://gemini.google.com/app/images', html: `
    <user-query id="photo"><h5>You said</h5><button>View image<img src="photo.png"></button><div class="query-text"></div></user-query>
    <model-response><img src="answer.png"></model-response>
    <user-query id="mixed"><img src="diagram.png"><div class="query-text">Read this diagram</div></user-query>
  ` });
  assert.deepEqual(app.titles(), ['Image 1', 'Read this diagram']);
  app.shadow.querySelector('.item').click();
  await eventually(() => app.jumps.length > 0);
  assert.equal(app.jumps[0].element.id, 'photo');
});

test('ChatGPT indexes ordinary user turns and saves provider-scoped conversation data', async (t) => {
  const options = {
    url: 'https://chatgpt.com/c/chat-123',
    html: `
      <main>
        <article data-testid="conversation-turn-1">
          <div class="bg-user-message text-user-message" id="first-user" data-message-id="user-1">
            <div class="flex flex-col items-end gap-1">
              <div class="markdown"><div class="text-size-chat whitespace-pre-wrap">First ChatGPT prompt</div></div>
              <button>Copy</button>
            </div>
          </div>
        </article>
        <article data-testid="conversation-turn-2">
          <div data-message-author-role="assistant">Assistant answer</div>
        </article>
        <article data-testid="conversation-turn-3">
          <div class="bg-user-message text-user-message" data-message-id="user-2">
            <img src="diagram.png" alt="Uploaded image">
            <div class="whitespace-pre-wrap">Explain this diagram</div>
          </div>
        </article>
        <article data-testid="conversation-turn-4">
          <div class="bg-user-message text-user-message" data-message-id="user-3">
            <img src="photo.png" alt="Uploaded image">
          </div>
        </article>
      </main>`
  };
  const app = await mount(t, options);
  assert.deepEqual(app.titles(), ['First ChatGPT prompt', 'Explain this diagram', 'Image 1']);
  app.shadow.querySelectorAll('.item')[0].click();
  await eventually(() => app.jumps.length > 0);
  assert.equal(app.jumps.at(-1).element.id, 'first-user');

  app.shadow.querySelectorAll('[aria-label="Add to favorites"]')[0].click();
  const record = Object.values(app.storage[storageKey].saved)[0];
  assert.equal(record.provider, 'chatgpt');
  assert.equal(record.conversationId, 'chatgpt:chat-123');
  assert.equal(record.conversationUrl, 'https://chatgpt.com/c/chat-123');
  assert.match(record.id, /^chatgpt:chat-123-/);

  const reloaded = await mount(t, { ...options, saved: app.storage });
  assert.deepEqual(reloaded.titles(), ['First ChatGPT prompt', 'Explain this diagram', 'Image 1']);
  assert.ok(reloaded.shadow.querySelector('.item.favorite'));
});

test('ChatGPT uses bg-user-message containers and reads their whitespace text', async (t) => {
  const app = await mount(t, {
    url: 'https://chatgpt.com/c/plain-dom',
    html: `
      <main>
        <div class="bg-user-message text-user-message" data-message-id="explicit-user">
          <div class="flex flex-col items-end gap-1">
            <div class="markdown"><div class="text-size-chat whitespace-pre-wrap">Explicit user prompt</div></div>
          </div>
        </div>
        <div class="markdown"><div class="whitespace-pre-wrap">Assistant answer</div></div>
      </main>`
  });
  assert.deepEqual(app.titles(), ['Explicit user prompt']);
  assert.equal(app.shadow.getElementById('load-history').textContent, 'Load full history');
});

test('ChatGPT new chat ignores homepage text, hidden old turns, and stale home indexes', async (t) => {
  const app = await mount(t, {
    url: 'https://chatgpt.com/',
    html: `
      <main>
        <h1 class="whitespace-pre-wrap">What's on the agenda today?</h1>
        <div class="whitespace-pre-wrap">Create an image</div>
        <section aria-hidden="true">
          <div class="bg-user-message text-user-message" data-message-id="old-message">
            <div class="whitespace-pre-wrap">Previous conversation prompt</div>
          </div>
        </section>
      </main>`,
    saved: {
      'aiChatNavigatorIndex:chatgpt:home': { entries: [{
        id: 'chatgpt:home-old-0',
        content: 'Stale cached prompt',
        fingerprint: 'stale:18',
        nativeId: 'stale-message'
      }] }
    }
  });
  assert.deepEqual(app.titles(), []);

  const liveTurn = app.window.document.createElement('div');
  liveTurn.className = 'bg-user-message text-user-message';
  liveTurn.setAttribute('data-message-id', 'live-message');
  liveTurn.innerHTML = '<div class="whitespace-pre-wrap">Current new-chat prompt</div>';
  app.window.document.querySelector('main').appendChild(liveTurn);
  await eventually(() => app.titles()[0] === 'Current new-chat prompt');
  assert.deepEqual(app.titles(), ['Current new-chat prompt']);
});

test('ChatGPT keeps indexed prompts when jumping temporarily unmounts a message', async (t) => {
  const app = await mount(t, {
    url: 'https://chatgpt.com/c/stable-list',
    html: `
      <main>
        <div class="bg-user-message text-user-message" id="first-prompt" data-message-id="first">
          <div class="whitespace-pre-wrap">First stable prompt</div>
        </div>
        <div class="bg-user-message text-user-message" id="second-prompt" data-message-id="second">
          <div class="whitespace-pre-wrap">Second stable prompt</div>
        </div>
      </main>`
  });
  assert.deepEqual(app.titles(), ['First stable prompt', 'Second stable prompt']);
  app.shadow.querySelectorAll('.item')[0].click();
  await eventually(() => app.jumps.length > 0);
  app.window.document.getElementById('first-prompt').remove();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(app.titles(), ['First stable prompt', 'Second stable prompt']);
});

test('DeepSeek indexes user bubbles, excludes assistant markdown, and supports its chat route', async (t) => {
  const options = {
    url: 'https://chat.deepseek.com/a/chat/s/deep-123',
    html: `
      <div class="ds-scroll-area">
        <div class="ds-message-list">
          <div class="ds-virtual-list__item" data-virtual-index="0" id="deep-first">
            <div class="ds-message" data-message-id="deep-user-1">
              <div class="fbb737a4">DeepSeek first prompt</div>
            </div>
          </div>
          <div class="ds-virtual-list__item" data-virtual-index="1">
            <div class="ds-message" data-message-id="deep-assistant-1">
              <div class="ds-markdown">Assistant answer</div>
            </div>
          </div>
          <div class="ds-virtual-list__item" data-virtual-index="2">
            <div class="ds-message" data-message-id="deep-user-2">
              <div class="fbb737a4">DeepSeek second prompt</div>
              <img src="deepseek-image.png" alt="Uploaded image">
            </div>
          </div>
          <div class="ds-virtual-list__item" data-virtual-index="3">
            <div class="ds-message" data-message-id="deep-user-image">
              <img src="deepseek-only-image.png" alt="Uploaded image">
            </div>
          </div>
        </div>
        <section aria-hidden="true">
          <div class="ds-message" data-message-id="other-conversation">
            <div class="fbb737a4">Hidden prompt from another conversation</div>
          </div>
        </section>
      </div>`,
    saved: {
      'aiChatNavigatorIndex:deepseek:deep-123': { entries: [{
        id: 'deepseek:deep-123-stale-0',
        content: 'Polluted prompt from another conversation',
        fingerprint: 'stale:38',
        nativeId: 'stale-message'
      }] }
    }
  };
  const app = await mount(t, options);
  assert.deepEqual(app.titles(), ['DeepSeek first prompt', 'DeepSeek second prompt', 'Image 1']);
  app.shadow.querySelector('.item').click();
  await eventually(() => app.jumps.length > 0);
  assert.equal(app.jumps.at(-1).element.getAttribute('data-message-id'), 'deep-user-1');

  app.shadow.querySelector('[aria-label="Add to favorites"]').click();
  const record = Object.values(app.storage[storageKey].saved)[0];
  assert.equal(record.provider, 'deepseek');
  assert.equal(record.conversationId, 'deepseek:deep-123');
  assert.equal(record.conversationUrl, 'https://chat.deepseek.com/a/chat/s/deep-123');
  assert.match(record.id, /^deepseek:deep-123-/);
});

test('DeepSeek structural fallback excludes assistant markdown when user markers are unavailable', async (t) => {
  const app = await mount(t, {
    url: 'https://chat.deepseek.com/a/chat/s/fallback',
    html: `
      <div class="ds-message" id="plain-user"><p>Plain user prompt</p></div>
      <div class="ds-message"><div class="ds-markdown">Assistant answer</div></div>`
  });
  assert.deepEqual(app.titles(), ['Plain user prompt']);
  app.shadow.querySelector('.item').click();
  await eventually(() => app.jumps.length > 0);
  assert.equal(app.jumps[0].element.id, 'plain-user');
});

test('image prompts retain renamed titles, pinned and global saved state after reload', async (t) => {
  const options = { html: '<div data-testid="send_message" data-message-id="photo"><img src="private-image.png"></div>' };
  const app = await mount(t, options);
  app.shadow.querySelector('[aria-label="Add to favorites"]').click();
  const initialSaved = await mount(t, { ...options, saved: app.storage });
  initialSaved.shadow.getElementById('saved-button').click();
  assert.equal(initialSaved.shadow.querySelector('.saved-title').textContent, 'Image 1');
  app.window.prompt = () => 'Circuit diagram';
  app.shadow.querySelector('[aria-label="Rename"]').click();
  const loaded = await mount(t, { ...options, saved: app.storage });
  assert.deepEqual(loaded.titles(), ['Circuit diagram']);
  assert.equal(loaded.shadow.querySelector('.pinned-title').textContent, 'Circuit diagram');
  loaded.shadow.getElementById('saved-button').click();
  assert.equal(loaded.shadow.querySelector('.saved-title').textContent, 'Circuit diagram');
  assert.equal(JSON.stringify(loaded.storage).includes('private-image.png'), false);
});

test('rename and favorite persist after reloading a Doubao conversation', async (t) => {
  const options = { html: '<div data-testid="send_message">Original prompt</div>' };
  const app = await mount(t, options);
  app.window.prompt = () => 'Project plan';
  app.shadow.querySelector('[aria-label="Rename"]').click();
  app.shadow.querySelector('[aria-label="Add to favorites"]').click();
  const reloaded = await mount(t, { ...options, saved: app.storage });
  assert.deepEqual(reloaded.titles(), ['Project plan']);
  assert.ok(reloaded.shadow.querySelector('.item.favorite'));
  reloaded.shadow.querySelector('[aria-label="Remove favorite"]').click();
  assert.equal(reloaded.shadow.querySelector('.item.favorite'), null);
});

test('Gemini keeps existing saved IDs; Doubao cannot reuse its titles or favorites', async (t) => {
  const gemini = await mount(t, {
    url: 'https://gemini.google.com/app/123',
    html: '<user-query><h5>You said Same prompt</h5><div class="query-text">Same prompt</div></user-query>'
  });
  assert.deepEqual(gemini.titles(), ['Same prompt']);
  gemini.window.prompt = () => 'Saved Gemini title';
  gemini.shadow.querySelector('[aria-label="Rename"]').click();
  gemini.shadow.querySelector('[aria-label="Add to favorites"]').click();
  const id = Object.keys(gemini.storage[storageKey].titles)[0];
  assert.match(id, /^123-/);
  const reloaded = await mount(t, {
    url: 'https://gemini.google.com/app/123', html: '<user-query>Same prompt</user-query>', saved: gemini.storage
  });
  assert.deepEqual(reloaded.titles(), ['Saved Gemini title']);
  assert.ok(reloaded.shadow.querySelector('.item.favorite'));
  const doubao = await mount(t, {
    html: '<div data-testid="send_message">Same prompt</div>', saved: gemini.storage
  });
  assert.deepEqual(doubao.titles(), ['Same prompt']);
  assert.equal(doubao.shadow.querySelector('.item.favorite'), null);
});

test('same-tab pushState and back navigation keep saved data in the correct conversation', async (t) => {
  const app = await mount(t, { html: '<div data-testid="send_message">Same prompt</div>' });
  app.window.prompt = () => 'Only in conversation 123';
  app.shadow.querySelector('[aria-label="Rename"]').click();
  app.window.history.pushState({}, '', '/chat/456');
  await eventually(() => app.titles()[0] === 'Same prompt');
  app.window.history.replaceState({}, '', '/chat/123');
  app.window.dispatchEvent(new app.window.PopStateEvent('popstate'));
  await eventually(() => app.titles()[0] === 'Only in conversation 123');
});

test('new messages and text-node edits update the index without reloading', async (t) => {
  const app = await mount(t, { html: '<div data-testid="send_message" id="prompt">Before</div>' });
  app.window.document.getElementById('prompt').firstChild.data = 'After';
  await eventually(() => app.titles()[0] === 'After');
  const added = app.window.document.createElement('div');
  added.setAttribute('data-testid', 'send_message');
  added.textContent = 'New prompt';
  app.window.document.body.appendChild(added);
  await eventually(() => app.titles().length === 2);
  assert.deepEqual(app.titles(), ['After', 'New prompt']);
});

test('repeated prompts have separate saved titles', async (t) => {
  const app = await mount(t, { html: '<div data-testid="send_message">Repeat</div><div data-testid="send_message">Repeat</div>' });
  app.window.prompt = () => 'Second repeat';
  app.shadow.querySelectorAll('[aria-label="Rename"]')[1].click();
  assert.deepEqual(app.titles(), ['Repeat', 'Second repeat']);
});

test('only supported chat pages receive the English panel', async (t) => {
  for (const url of ['https://example.com/chat/123', 'https://www.doubao.com/security/doubao-region-ban']) {
    const app = await mount(t, { url });
    assert.equal(app.shadow, undefined);
  }
  const app = await mount(t, { url: 'https://doubao.com/chat' });
  assert.equal(app.shadow.querySelector('section').getAttribute('aria-label'), 'AI Chat Navigator');
  assert.equal(app.shadow.querySelector('header').textContent, 'Chat Navigator');
  assert.equal(app.shadow.querySelector('.empty').textContent, 'No prompts found');
});

test('a stalled saved-index read times out without disabling Load full history', async (t) => {
  const app = await mount(t, {
    html: '<div data-testid="send_message">Prompt after storage timeout</div>',
    setup(window) {
      const Original = window.AIChatHistoryIndex;
      window.AIChatHistoryIndex = class extends Original {
        constructor(config) { super({ ...config, storageTimeout: 20 }); }
      };
      const local = window.chrome.storage.local;
      const originalGet = local.get;
      local.get = function (keys, callback) {
        if (Array.isArray(keys) && keys.length === 1
          && String(keys[0]).startsWith('aiChatNavigatorIndex:')) return;
        return originalGet.call(this, keys, callback);
      };
    }
  });
  const button = app.shadow.getElementById('load-history');
  assert.equal(button.disabled, false);
  await eventually(() => app.shadow.getElementById('history-status').textContent.includes('took too long'));
  assert.deepEqual(app.titles(), ['Prompt after storage timeout']);
  assert.equal(button.disabled, false);
});

function virtualConversation({ count = 12, prepend = 0, repeated = false, images = false, stepDelay = 5, maxDuration = 4000 } = {}) {
  const control = { writes: 0 };
  const options = {
    html: '<div data-testid="message-list"><div class="scroller" style="overflow-y:auto"></div></div>',
    setup(window) {
      const Original = window.AIChatHistoryIndex;
      window.AIChatHistoryIndex = class extends Original {
        constructor(config) { super({ ...config, stepDelay, boundaryDelay: 20, boundaryPasses: 3, maxDuration }); }
      };
      const scroller = window.document.querySelector('.scroller');
      let firstId = prepend;
      let loaded = count;
      let offset = (loaded - 2) * 100;
      let requested = false;
      Object.defineProperties(scroller, {
        clientHeight: { get: () => 200 },
        scrollHeight: { get: () => loaded * 100 },
        scrollTop: {
          get: () => offset,
          set(value) {
            control.writes += 1;
            offset = Math.max(0, Math.min(value, loaded * 100 - 200));
            draw();
          }
        }
      });
      const rectangle = (top, height) => ({ top, bottom: top + height, left: 0, right: 500, width: 500, height, x: 0, y: top });
      window.Element.prototype.getBoundingClientRect = function () {
        if (this === scroller) return rectangle(0, 200);
        const row = this.closest('.v_list_row');
        return rectangle(row ? Number(row.getAttribute('data-fixture-index')) * 100 - offset : 0, 100);
      };
      function draw() {
        const start = Math.floor(offset / 100);
        scroller.innerHTML = Array.from({ length: Math.min(3, loaded - start) }, (_, i) => {
          const index = start + i;
          const id = firstId + index;
          return `<div class="v_list_row" data-fixture-index="${index}" style="--cls:r-${index}-0_block_${id}">
            <div data-testid="send_message"><div data-testid="message_content" data-message-id="msg-${id}">
              ${images ? '<img src="photo.png">' : `<div data-testid="message_text_content">${repeated ? 'Repeat' : `Question ${id}`}</div>`}
            </div></div>
          </div>`;
        }).join('');
      }
      scroller.addEventListener('scroll', () => {
        if (offset === 0 && firstId && !requested) {
          requested = true;
          window.setTimeout(() => {
            loaded += firstId;
            offset += firstId * 100;
            firstId = 0;
            draw();
          }, 30);
        }
      });
      draw();
      Object.assign(control, { scroller, scroll(top) { scroller.scrollTop = top; scroller.dispatchEvent(new window.Event('scroll')); } });
    }
  };
  return { options, control };
}

function virtualDeepSeekConversation({ count = 12, prepend = 0, stepDelay = 5, maxDuration = 4000 } = {}) {
  const control = { writes: 0 };
  const options = {
    url: 'https://chat.deepseek.com/a/chat/s/virtual-deep',
    html: '<div class="ds-scroll-area" style="overflow-y:auto"></div>',
    setup(window) {
      const Original = window.AIChatHistoryIndex;
      window.AIChatHistoryIndex = class extends Original {
        constructor(config) { super({ ...config, stepDelay, boundaryDelay: 20, boundaryPasses: 3, maxDuration }); }
      };
      const scroller = window.document.querySelector('.ds-scroll-area');
      let firstId = prepend;
      let loaded = count;
      let offset = (loaded - 2) * 100;
      let requested = false;
      Object.defineProperties(scroller, {
        clientHeight: { get: () => 200 },
        scrollHeight: { get: () => loaded * 100 },
        scrollTop: {
          get: () => offset,
          set(value) {
            control.writes += 1;
            offset = Math.max(0, Math.min(value, loaded * 100 - 200));
            draw();
          }
        }
      });
      const rectangle = (top, height) => ({ top, bottom: top + height, left: 0, right: 500, width: 500, height, x: 0, y: top });
      window.Element.prototype.getBoundingClientRect = function () {
        if (this === scroller) return rectangle(0, 200);
        const row = this.closest('[data-virtual-index]');
        return rectangle(row ? Number(row.getAttribute('data-virtual-index')) * 100 - offset : 0, 100);
      };
      function draw() {
        const start = Math.floor(offset / 100);
        scroller.innerHTML = Array.from({ length: Math.min(3, loaded - start) }, (_, i) => {
          const index = start + i;
          const id = firstId + index;
          return `<div class="ds-virtual-list__item" data-virtual-index="${index}" data-fixture-index="${index}">
            <div class="ds-message" data-message-id="deep-msg-${id}">
              <div class="fbb737a4">DeepSeek question ${id}</div>
            </div>
          </div>`;
        }).join('');
      }
      scroller.addEventListener('scroll', () => {
        if (offset === 0 && firstId && !requested) {
          requested = true;
          window.setTimeout(() => {
            loaded += firstId;
            offset += firstId * 100;
            firstId = 0;
            draw();
          }, 30);
        }
      });
      draw();
      Object.assign(control, { scroller, scroll(top) { scroller.scrollTop = top; scroller.dispatchEvent(new window.Event('scroll')); } });
    }
  };
  return { options, control };
}

function scrollableChatGPTConversation({ stepDelay = 5, maxDuration = 4000, withInitialUsers = true } = {}) {
  const control = { writes: 0 };
  const options = {
    url: 'https://chatgpt.com/c/long-chat',
    html: '<main id="chat-scroller" style="overflow-y:auto"></main>',
    setup(window) {
      const Original = window.AIChatHistoryIndex;
      window.AIChatHistoryIndex = class extends Original {
        constructor(config) { super({ ...config, stepDelay, boundaryDelay: 20, boundaryPasses: 3, maxDuration }); }
      };
      const scroller = window.document.getElementById('chat-scroller');
      let first = 6;
      let offset = 800;
      let requested = false;
      Object.defineProperties(scroller, {
        clientHeight: { get: () => 200 },
        scrollHeight: { get: () => 1000 },
        scrollTop: {
          get: () => offset,
          set(value) {
            control.writes += 1;
            offset = Math.max(0, Math.min(value, 800));
            draw();
          }
        }
      });
      const rectangle = (top, height) => ({ top, bottom: top + height, left: 0, right: 500, width: 500, height, x: 0, y: top });
      window.Element.prototype.getBoundingClientRect = function () {
        if (this === scroller) return rectangle(0, 200);
        const turn = this.closest('[data-fixture-index]');
        return rectangle(turn ? Number(turn.getAttribute('data-fixture-index')) * 100 - offset : 0, 100);
      };
      function draw() {
        scroller.innerHTML = Array.from({ length: 10 - first }, (_, i) => {
          const index = first + i;
          const content = withInitialUsers || first === 0
            ? `<div class="bg-user-message text-user-message" data-message-id="chatgpt-user-${index}">
                <div class="text-size-chat whitespace-pre-wrap">ChatGPT prompt ${index}</div>
              </div>`
            : `<div class="markdown">Assistant reply ${index}</div>`;
          return `<article data-testid="conversation-turn-${index}" data-fixture-index="${index}">
            ${content}
          </article>`;
        }).join('');
      }
      scroller.addEventListener('scroll', () => {
        if (offset === 0 && first === 6 && !requested) {
          requested = true;
          window.setTimeout(() => {
            first = 0;
            offset = 600;
            draw();
          }, 30);
        }
      });
      draw();
      Object.assign(control, { scroller, scroll(top) { scroller.scrollTop = top; scroller.dispatchEvent(new window.Event('scroll')); } });
    }
  };
  return { options, control };
}

test('ChatGPT Load full history scrolls up, indexes older turns, and restores the reading position', async (t) => {
  const { options, control } = scrollableChatGPTConversation();
  const app = await mount(t, options);
  assert.deepEqual(app.titles(), ['ChatGPT prompt 6', 'ChatGPT prompt 7', 'ChatGPT prompt 8', 'ChatGPT prompt 9']);
  const original = control.scroller.scrollTop;
  app.shadow.getElementById('load-history').click();
  await eventually(() => app.shadow.getElementById('history-status').textContent.startsWith('History scanned.'));
  assert.deepEqual(app.titles(), Array.from({ length: 10 }, (_, i) => `ChatGPT prompt ${i}`));
  assert.equal(control.scroller.scrollTop, original);
  app.search('ChatGPT prompt 0');
  assert.deepEqual(app.titles(), ['ChatGPT prompt 0']);
  app.shadow.querySelector('.item').click();
  await eventually(() => app.jumps.length > 0);
  const target = app.jumps.at(-1).element;
  assert.equal(
    (target.matches('[data-message-id]') ? target : target.querySelector('[data-message-id]'))
      .getAttribute('data-message-id'),
    'chatgpt-user-0'
  );
});

test('ChatGPT Load full history finds the scroller when no user prompt is mounted yet', async (t) => {
  const { options, control } = scrollableChatGPTConversation({ withInitialUsers: false });
  const app = await mount(t, options);
  assert.deepEqual(app.titles(), []);
  const original = control.scroller.scrollTop;
  app.shadow.getElementById('load-history').click();
  await eventually(() => app.shadow.getElementById('history-status').textContent.startsWith('History scanned.'));
  assert.deepEqual(app.titles(), Array.from({ length: 10 }, (_, i) => `ChatGPT prompt ${i}`));
  assert.equal(control.scroller.scrollTop, original);
});

test('DeepSeek virtual history retains unmounted prompts and locates them by message ID', async (t) => {
  const { options, control } = virtualDeepSeekConversation();
  const app = await mount(t, options);
  assert.deepEqual(app.titles(), ['DeepSeek question 10', 'DeepSeek question 11']);
  const original = control.scroller.scrollTop;
  app.shadow.getElementById('load-history').click();
  await eventually(() => app.shadow.getElementById('history-status').textContent.startsWith('History scanned.'));
  assert.deepEqual(app.titles(), Array.from({ length: 12 }, (_, i) => `DeepSeek question ${i}`));
  assert.equal(control.scroller.scrollTop, original);
  app.search('DeepSeek question 0');
  assert.deepEqual(app.titles(), ['DeepSeek question 0']);
  app.shadow.querySelector('.item').click();
  await eventually(() => app.jumps.length > 0);
  const target = app.jumps.at(-1).element;
  assert.equal(
    (target.matches('[data-message-id]') ? target : target.querySelector('[data-message-id]'))
      .getAttribute('data-message-id'),
    'deep-msg-0'
  );
});

test('image numbers follow the full index across search and locate unloaded images from an older cache', async (t) => {
  const { options } = virtualConversation({ count: 6, images: true });
  const app = await mount(t, options);
  app.shadow.getElementById('load-history').click();
  await eventually(() => app.shadow.getElementById('history-status').textContent.startsWith('History scanned.'));
  await eventually(() => app.storage['aiChatNavigatorIndex:doubao:123']?.entries.length === 6);
  for (const entry of app.storage['aiChatNavigatorIndex:doubao:123'].entries) delete entry.imageOnly;
  const loaded = await mount(t, { ...virtualConversation({ count: 6, images: true }).options, saved: app.storage });
  assert.deepEqual(loaded.titles(), Array.from({ length: 6 }, (_, i) => `Image ${i + 1}`));
  assert.equal(loaded.window.document.querySelectorAll('img').length, 2);
  loaded.search('Image 2');
  assert.deepEqual(loaded.titles(), ['Image 2']);
  loaded.shadow.querySelector('.item').click();
  await eventually(() => loaded.jumps.length > 0);
  assert.equal(loaded.jumps.at(-1).element.querySelector('[data-message-id]').getAttribute('data-message-id'), 'msg-1');
  assert.equal(loaded.jumps.at(-1).options.behavior, 'smooth');
});

test('history scan visits virtual windows, retains unmounted prompts, and restores the reading position', async (t) => {
  const { options, control } = virtualConversation();
  const app = await mount(t, options);
  assert.deepEqual(app.titles(), ['Question 10', 'Question 11']);
  const original = control.scroller.scrollTop;
  app.shadow.getElementById('load-history').click();
  await eventually(() => app.shadow.getElementById('history-status').textContent.startsWith('History scanned.'));
  assert.deepEqual(app.titles(), Array.from({ length: 12 }, (_, i) => `Question ${i}`));
  assert.ok(control.scroller.querySelectorAll('[data-testid="send_message"]').length < 12);
  assert.equal(control.scroller.scrollTop, original);
  app.search('Question 0');
  assert.deepEqual(app.titles(), ['Question 0']);
  app.shadow.querySelector('.item').click();
  await eventually(() => app.jumps.length > 0);
  assert.equal(app.jumps.at(-1).element.querySelector('[data-message-id]').getAttribute('data-message-id'), 'msg-0');
  assert.ok(app.jumps.at(-1).element.isConnected);
});

test('pagination at the top loads earlier history before a scan finishes', async (t) => {
  const { options, control } = virtualConversation({ count: 8, prepend: 4 });
  const app = await mount(t, options);
  app.shadow.getElementById('load-history').click();
  await eventually(() => app.shadow.getElementById('history-status').textContent.startsWith('History scanned.'));
  assert.deepEqual(app.titles(), Array.from({ length: 12 }, (_, i) => `Question ${i}`));
  assert.equal(control.scroller.scrollTop, 1000);
});

test('cached history survives a reload even when only the latest virtual window is mounted', async (t) => {
  const { options } = virtualConversation();
  const app = await mount(t, options);
  app.shadow.getElementById('load-history').click();
  await eventually(() => app.shadow.getElementById('history-status').textContent.startsWith('History scanned.'));
  await eventually(() => app.storage['aiChatNavigatorIndex:doubao:123']?.entries.length === 12);
  const reloaded = await mount(t, { ...virtualConversation().options, saved: app.storage });
  assert.equal(reloaded.titles().length, 12);
  assert.equal(reloaded.window.document.querySelectorAll('[data-testid="send_message"]').length, 2);
  const saved = app.storage['aiChatNavigatorIndex:doubao:123'].entries;
  assert.equal(saved.some((entry) => Object.hasOwn(entry, 'element')), false);
});

test('identical prompts in separate virtual windows keep distinct titles and jump by message ID', async (t) => {
  const { options } = virtualConversation({ count: 6, repeated: true });
  const app = await mount(t, options);
  app.shadow.getElementById('load-history').click();
  await eventually(() => app.shadow.getElementById('history-status').textContent.startsWith('History scanned.'));
  assert.equal(app.titles().length, 6);
  app.window.prompt = () => 'First repeat';
  app.shadow.querySelector('[aria-label="Rename"]').click();
  assert.deepEqual(app.titles(), ['First repeat', 'Repeat', 'Repeat', 'Repeat', 'Repeat', 'Repeat']);
  app.shadow.querySelector('.item').click();
  await eventually(() => app.jumps.length > 0);
  assert.equal(app.jumps.at(-1).element.querySelector('[data-message-id]').getAttribute('data-message-id'), 'msg-0');
});

test('Stop cancels an in-progress scan and keeps the partial index', async (t) => {
  const { options, control } = virtualConversation({ count: 80, stepDelay: 40 });
  const app = await mount(t, options);
  const button = app.shadow.getElementById('load-history');
  button.click();
  await eventually(() => app.titles().length > 2);
  assert.equal(button.textContent, 'Stop');
  button.click();
  const writes = control.writes;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(control.writes, writes);
  assert.equal(button.textContent, 'Load full history');
  assert.ok(app.titles().length > 2 && app.titles().length < 80);
  assert.match(app.shadow.getElementById('history-status').textContent, /^Stopped/);
});

test('prompts discovered while scanning upward stay below the latest prompt', async (t) => {
  const { options } = virtualConversation({ count: 80, stepDelay: 40 });
  const app = await mount(t, options);
  const button = app.shadow.getElementById('load-history');
  button.click();
  await eventually(() => app.titles().length >= 8);
  const visual = Array.from(app.shadow.querySelectorAll('#list .item'))
    .sort((left, right) => Number(left.style.order) - Number(right.style.order));
  assert.equal(visual[0].querySelector('.title').textContent, 'Question 79');
  button.click();
});

test('a time-limited scan reports a partial index instead of claiming complete history', async (t) => {
  const { options } = virtualConversation({ count: 80, stepDelay: 20, maxDuration: 10 });
  const app = await mount(t, options);
  app.shadow.getElementById('load-history').click();
  await eventually(() => app.shadow.getElementById('history-status').textContent.startsWith('Scan paused'));
  assert.ok(app.titles().length < 80);
  assert.equal(app.shadow.getElementById('load-history').textContent, 'Load full history');
});

test('recycled elements do not cause a cached prompt to highlight a different message', async (t) => {
  const app = await mount(t, { html: '<div data-testid="send_message"><div data-message-id="old"><div data-testid="message_text_content">Old prompt</div></div></div>' });
  const recycled = app.window.document.querySelector('[data-message-id]');
  recycled.setAttribute('data-message-id', 'new');
  recycled.firstElementChild.textContent = 'New prompt';
  await eventually(() => app.titles().length === 2);
  app.shadow.querySelector('.item').click();
  await eventually(() => app.shadow.getElementById('history-status').textContent.includes('Open the conversation'));
  assert.equal(app.jumps.length, 0);
});

test('switching conversations does not add the previous route\'s mounted messages to the new index', async (t) => {
  const app = await mount(t, { html: '<div data-testid="send_message"><div data-message-id="old">Old prompt</div></div>' });
  app.window.history.pushState({}, '', '/chat/other');
  app.window.dispatchEvent(new app.window.PopStateEvent('popstate'));
  await eventually(() => app.titles().length === 0);
  const node = app.window.document.querySelector('[data-message-id]');
  node.setAttribute('data-message-id', 'new');
  node.textContent = 'New conversation prompt';
  await eventually(() => app.titles()[0] === 'New conversation prompt');
  assert.deepEqual(app.titles(), ['New conversation prompt']);
});

test('ordinary text ending in a filename remains indexed and saved after reload', async (t) => {
  for (const prompt of ['Please explain the filename report.pdf', '请解释这个文件 report.pdf', 'report.pdf']) {
    const html = '<div data-testid="send_message"><div data-testid="message_text_content"></div></div>';
    const setup = (window) => { window.document.querySelector('[data-testid="message_text_content"]').textContent = prompt; };
    const app = await mount(t, { html, setup });
    assert.deepEqual(app.titles(), [prompt]);
    app.shadow.querySelector('[aria-label="Add to favorites"]').click();
    const loaded = await mount(t, { html, setup, saved: app.storage });
    assert.deepEqual(loaded.titles(), [prompt]);
    loaded.shadow.getElementById('saved-button').click();
    assert.equal(loaded.shadow.querySelector('.saved-title').textContent, prompt);
  }
});

test('legacy cached text ending in a filename is retained', async (t) => {
  const app = await mount(t, { saved: {
    'aiChatNavigatorIndex:doubao:123': { entries: [{ id: 'doubao:123-old-0',
      content: 'Please explain report.pdf', fingerprint: 'old:25', nativeId: 'saved-id',
      rowIndex: 0, position: 0 }] }
  } });
  assert.deepEqual(app.titles(), ['Please explain report.pdf']);
});

test('formal message IDs preserve pinned state, title and saved metadata', async (t) => {
  for (const temporaryId of [null, 'local_123', 'temp:123']) {
    const app = await mount(t, { html: '<div data-testid="send_message"><div data-testid="message_text_content">Same prompt</div></div>',
      setup(window) {
        if (temporaryId) window.document.querySelector('[data-testid="send_message"]').setAttribute('data-message-id', temporaryId);
      }
    });
    app.window.prompt = () => 'My pinned title';
    app.shadow.querySelector('[aria-label="Rename"]').click();
    app.shadow.querySelector('[aria-label="Add to favorites"]').click();
    const originalId = Object.keys(app.storage[storageKey].saved)[0];
    app.window.document.querySelector('[data-testid="send_message"]').setAttribute('data-message-id', 'formal-123');
    await eventually(() => app.storage[storageKey].saved[originalId].nativeId === 'formal-123');
    assert.deepEqual(app.titles(), ['My pinned title']);
    assert.equal(app.shadow.getElementById('pinned-count').textContent, '(1)');
    assert.equal(app.shadow.getElementById('saved-count').textContent, '1');
    assert.equal(app.shadow.getElementById('pinned-section').hidden, false);
    assert.ok(app.shadow.querySelector('#list [aria-label="Remove favorite"]'));
    await eventually(() => app.storage['aiChatNavigatorIndex:doubao:123']?.entries.length === 1);
    const stored = app.storage['aiChatNavigatorIndex:doubao:123'].entries[0];
    assert.equal(stored.id, originalId);
    assert.equal(stored.nativeId, 'formal-123');
  }
});

test('different stable message IDs on recycled elements remain distinct', async (t) => {
  const app = await mount(t, { html: '<div data-testid="send_message" data-message-id="stable-a">Repeat</div>' });
  app.shadow.querySelector('[aria-label="Add to favorites"]').click();
  app.window.document.querySelector('[data-message-id]').setAttribute('data-message-id', 'stable-b');
  await eventually(() => app.shadow.querySelectorAll('#list .item').length === 2);
  assert.equal(app.shadow.querySelectorAll('#list [aria-label="Remove favorite"]').length, 1);
  assert.equal(app.shadow.querySelectorAll('#list [aria-label="Add to favorites"]').length, 1);
});

test('identical text without position evidence is not hidden as an ID promotion', async (t) => {
  const app = await mount(t, { html: '<div data-testid="send_message">Repeat</div><div data-testid="send_message" data-message-id="stable">Repeat</div>' });
  assert.deepEqual(app.titles(), ['Repeat', 'Repeat']);
});

async function pendingSample(t) {
  const original = await mount(t, { html: '<div data-testid="send_message" data-message-id="target">Saved prompt</div>' });
  original.shadow.querySelector('[aria-label="Add to favorites"]').click();
  const saved = structuredClone(original.storage);
  const record = Object.values(saved[storageKey].saved)[0];
  saved.aiChatNavigatorPendingTarget = { ...record, pendingAt: Date.now() };
  saved['aiChatNavigatorIndex:doubao:123'] = { entries: [{ ...record, fingerprint: record.fingerprint }] };
  return saved;
}

test('cross-chat navigation waits for hydrated DOM instead of consuming a cached target early', async (t) => {
  const app = await mount(t, { saved: await pendingSample(t) });
  assert.equal(app.titles().length, 1);
  assert.ok(app.storage.aiChatNavigatorPendingTarget);
  assert.match(app.shadow.getElementById('history-status').textContent, /Waiting/);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(app.storage.aiChatNavigatorPendingTarget);
  assert.equal(app.jumps.length, 0);
  const message = app.window.document.createElement('div');
  message.setAttribute('data-testid', 'send_message');
  message.setAttribute('data-message-id', 'target');
  message.textContent = 'Saved prompt';
  app.window.document.body.appendChild(message);
  await eventually(() => app.jumps.length === 1);
  await eventually(() => !app.storage.aiChatNavigatorPendingTarget);
  assert.equal(app.jumps[0].element, message);
  assert.equal(app.shadow.getElementById('toggle').getAttribute('aria-expanded'), 'true');
});

test('failed first locate is retried while the saved page finishes rendering', async (t) => {
  let attempts = 0;
  const app = await mount(t, { saved: await pendingSample(t), setup(window) {
    const Original = window.AIChatHistoryIndex;
    window.AIChatHistoryIndex = class extends Original {
      getScroller() { return { clientHeight: 200 }; }
      async locate() {
        attempts += 1;
        if (attempts === 1) return null;
        const node = window.document.createElement('div');
        node.textContent = 'Saved prompt';
        window.document.body.appendChild(node);
        return node;
      }
    };
  } });
  await eventually(() => app.jumps.length === 1);
  assert.equal(attempts, 2);
  await eventually(() => !app.storage.aiChatNavigatorPendingTarget);
});

test('pending navigation times out with a visible error', async (t) => {
  const saved = await pendingSample(t);
  saved.aiChatNavigatorPendingTarget.pendingAt = Date.now() - 31000;
  const app = await mount(t, { saved });
  assert.equal(app.storage.aiChatNavigatorPendingTarget, undefined);
  assert.match(app.shadow.getElementById('history-status').textContent, /timeout/);
  assert.equal(app.jumps.length, 0);
});
