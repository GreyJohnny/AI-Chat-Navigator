import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
const storageKey = 'geminiChatNavigatorData';

async function mount(t, { html = '', url = 'https://www.doubao.com/chat/123', saved = {} } = {}) {
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
