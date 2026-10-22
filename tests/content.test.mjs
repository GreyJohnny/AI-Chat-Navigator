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
    set(values, callback) { Object.assign(storage, structuredClone(values)); callback?.(); }
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

test('Doubao text and attachment titles exclude controls; image messages remain navigable', async (t) => {
  const app = await mount(t, { html: `
    <div data-testid="send_message">
      <div data-testid="message_text_content">Explain this file</div>
      <div data-testid="message_nested_content_file_name">notes.pdf</div><button>Download</button>
    </div>
    <div data-testid="send_message"><img src="data:image/png;base64," alt="Uploaded image"></div>
    <div data-testid="send_message"><div data-testid="message_nested_content_file_name">report.txt</div></div>
  ` });
  assert.deepEqual(app.titles(), ['Explain this file notes.pdf', 'Image message', 'report.txt']);
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

function virtualConversation({ count = 12, prepend = 0, repeated = false, stepDelay = 5, maxDuration = 4000 } = {}) {
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
              <div data-testid="message_text_content">${repeated ? 'Repeat' : `Question ${id}`}</div>
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
