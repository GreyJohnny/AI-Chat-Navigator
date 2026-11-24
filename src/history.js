(() => {
  'use strict';

  const pause = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function isPrompt(content) {
    const value = String(content || '').replace(/\s+/g, ' ').trim();
    return Boolean(value);
  }

  // Keep a message index independent of virtualized DOM nodes. All reads use
  // rendered page content; no private APIs or application state are needed.
  class ChatHistoryIndex {
    constructor({ readMessages, conversationId, onChange, findScroller, historyMode, mirrorDom, indexVersion,
      readNativeId, readRowIndex, visibleRowIndexes, stepDelay = 300,
      boundaryDelay = 1000, boundaryPasses = 3, maxDuration = 120000,
      locateDelay = 140, locateTimeout = 10000, storageTimeout = 1500,
      pollInterval = 30, minStepDelay = 45, minBoundaryDelay = 120 }) {
      Object.assign(this, { readMessages, conversationId, onChange, stepDelay,
        findScroller, historyMode, mirrorDom, indexVersion, readNativeId, readRowIndex, visibleRowIndexes,
        boundaryDelay, boundaryPasses, maxDuration, locateDelay, locateTimeout, storageTimeout,
        pollInterval, minStepDelay, minBoundaryDelay });
      this.states = new Map();
      this.activeId = null;
      this.operation = null;
      this.lastNativeSignature = '';
      this.scanDirection = 0;
      const interrupt = (event) => {
        if (event.composedPath().some((node) => node.id === 'ai-chat-navigator-host')) return;
        if (event.type !== 'keydown' || ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
          this.cancel();
        }
      };
      document.addEventListener('wheel', interrupt, { passive: true });
      document.addEventListener('touchstart', interrupt, { passive: true });
      document.addEventListener('keydown', interrupt);
    }

    get state() { return this.states.get(this.activeId); }
    get busy() { return Boolean(this.operation && this.valid(this.operation)); }
    get loading() { return Boolean(this.state?.loading); }
    storageKey(id) { return `aiChatNavigatorIndex:${id}`; }

    activate() {
      const id = this.conversationId();
      if (id === this.activeId) return;
      this.cancel(false);
      this.activeId = id;
      if (this.states.has(id) && !(this.mirrorDom && id.endsWith(':home'))) {
        this.state.pendingSignature = this.lastNativeSignature;
        return;
      }
      if (this.states.has(id)) this.states.delete(id);
      const state = { entries: new Map(), loading: true, message: '',
        pendingSignature: this.lastNativeSignature, saveTimer: null };
      this.states.set(id, state);
      if (this.mirrorDom) {
        state.loading = false;
        this.onChange();
        return;
      }
      let settled = false;
      const finishLoading = (message = '') => {
        if (settled) return;
        settled = true;
        window.clearTimeout(storageTimer);
        state.loading = false;
        if (message) state.message = message;
        if (this.activeId === id && this.conversationId() === id) this.onChange();
      };
      const storageTimer = window.setTimeout(() => {
        finishLoading('Saved index took too long to load. Load full history is still available.');
      }, this.storageTimeout);
      try {
        chrome.storage.local.get([this.storageKey(id)], (result) => {
          if (settled) return;
          const saved = result[this.storageKey(id)];
          const currentVersion = this.indexVersion == null || saved?.version === this.indexVersion;
          if (currentVersion && Array.isArray(saved?.entries)) {
            saved.entries.forEach((entry) => {
              if (entry && isPrompt(entry.content)
                && typeof entry.id === 'string' && typeof entry.content === 'string'
                && typeof entry.fingerprint === 'string') {
                state.entries.set(entry.nativeId ? `message:${entry.nativeId}` : `legacy:${entry.id}`, {
                  ...entry,
                  element: null,
                  mountedOrder: null,
                  order: Number.isFinite(entry.order) ? entry.order
                    : Number.isFinite(entry.rowIndex) ? entry.rowIndex
                      : Number.isFinite(entry.position) ? entry.position : null
                });
              }
            });
          }
          finishLoading();
        });
      } catch {
        finishLoading('Could not read the saved index. Load full history is still available.');
      }
    }

    getScroller() {
      if (this.findScroller) return this.findScroller();
      const known = document.querySelector('[data-testid="message-list"] .scroller');
      if (known) return known;
      const message = this.readMessages()[0]?.element;
      for (let node = message?.parentElement; node; node = node.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.clientHeight > 0) return node;
      }
      return null;
    }

    metadata(entry, scroller, mountedOrder = null) {
      const node = entry.element;
      const nativeNode = node.matches('[data-message-id]') ? node
        : node.querySelector('[data-message-id]') || node.closest('[data-message-id]');
      const nativeId = this.readNativeId?.(node)
        || nativeNode?.getAttribute('data-message-id') || null;
      const row = node.closest('.v_list_row');
      const order = row?.style.getPropertyValue('--cls').match(/^r-(\d+)-/);
      const rowIndex = this.readRowIndex?.(node);
      const position = scroller ? Math.round(scroller.scrollTop + node.getBoundingClientRect().top - scroller.getBoundingClientRect().top) : null;
      const computedOrder = Number.isFinite(rowIndex) ? rowIndex
        : Number.isFinite(position) ? position : null;
      return {
        ...entry,
        nativeId,
        mountedOrder,
        rowIndex: Number.isFinite(rowIndex) ? rowIndex
          : order ? Number(order[1]) : entry.rowIndex ?? null,
        position,
        order: Number.isFinite(computedOrder) ? computedOrder : entry.order ?? null
      };
    }

    sync() {
      this.activate();
      const state = this.state;
      if (state.loading) return [];
      const scroller = this.getScroller();
      const mounted = this.readMessages().map(
        (entry, mountedOrder) => this.metadata(entry, scroller, mountedOrder)
      );
      const signature = mounted.map((entry) => entry.nativeId || '').filter(Boolean).join(',');
      // A route can change before the previous conversation's DOM is replaced.
      if (state.pendingSignature && signature === state.pendingSignature) return this.entries();
      state.pendingSignature = '';
      this.lastNativeSignature = signature;
      let dirty = false;
      mounted.forEach((entry) => {
        let key = entry.nativeId ? `message:${entry.nativeId}` : `legacy:${entry.id}`;
        if (entry.nativeId && !state.entries.has(key)) {
          const promoted = Array.from(state.entries).find(([, saved]) => {
            const temporary = !saved.nativeId || /^(?:local|temp|pending)[_:-]/i.test(saved.nativeId);
            if (!temporary || saved.fingerprint !== entry.fingerprint) return false;
            if (saved.rowIndex !== null && entry.rowIndex !== null) return saved.rowIndex === entry.rowIndex;
            if (saved.element === entry.element) return true;
            return Number.isFinite(saved.position) && Number.isFinite(entry.position)
              && Math.abs(saved.position - entry.position) <= 2;
          });
          if (promoted) {
            // Re-key the same logical message, preserving its navigation ID,
            // title and saved state instead of allocating another occurrence.
            state.entries.delete(promoted[0]);
            state.entries.set(key, promoted[1]);
            dirty = true;
          }
        }
        if (!entry.nativeId) {
          const existing = Array.from(state.entries).find(([, saved]) => saved.element === entry.element);
          if (existing) key = existing[0];
        }
        const previous = state.entries.get(key);
        if (previous) {
          const updated = {
            ...previous,
            ...entry,
            id: previous.id,
            order: Number.isFinite(entry.order) ? entry.order : previous.order ?? null
          };
          dirty ||= ['content', 'fingerprint', 'hasImage', 'imageCount', 'imageOnly', 'rowIndex', 'position', 'order']
            .some((field) => previous[field] !== updated[field]);
          state.entries.set(key, updated);
        } else {
          if (!Number.isFinite(entry.order)) {
            const knownOrders = Array.from(state.entries.values(), (saved) => saved.order)
              .filter(Number.isFinite);
            if (this.scanDirection < 0) {
              entry.order = knownOrders.length ? Math.min(...knownOrders) - 1 : 0;
            } else if (this.scanDirection > 0) {
              entry.order = knownOrders.length ? Math.max(...knownOrders) + 1 : 0;
            }
          }
          // Preserve 2.1 navigation IDs while assigning distinct IDs to repeated
          // prompts encountered in different virtual windows.
          const used = new Set(Array.from(state.entries.values(), (saved) => saved.id));
          let occurrence = 0;
          while (used.has(entry.id)) entry.id = `${this.activeId}-${entry.fingerprint}-${++occurrence}`;
          state.entries.set(key, entry);
          dirty = true;
        }
      });
      state.entries.forEach((entry) => {
        if (!entry.element?.isConnected) {
          entry.element = null;
          entry.mountedOrder = null;
        }
      });
      if (dirty) this.persist(this.activeId, state);
      return this.entries();
    }

    entries() {
      return Array.from(this.state.entries.values()).sort((a, b) => {
        if (Number.isFinite(a.order) && Number.isFinite(b.order)) {
          return a.order - b.order;
        }
        if (a.mountedOrder !== null && b.mountedOrder !== null) {
          return a.mountedOrder - b.mountedOrder;
        }
        if (a.rowIndex !== null && b.rowIndex !== null) return a.rowIndex - b.rowIndex;
        if (a.position !== null && b.position !== null) return a.position - b.position;
        return 0;
      });
    }

    persist(id, state) {
      if (this.mirrorDom) return;
      window.clearTimeout(state.saveTimer);
      state.saveTimer = window.setTimeout(() => {
        const entries = Array.from(state.entries.values(), ({ element, mountedOrder, ...entry }) => entry);
        const value = this.indexVersion == null ? { entries } : { version: this.indexVersion, entries };
        chrome.storage.local.set({ [this.storageKey(id)]: value }, () => {
          if (chrome.runtime?.lastError) {
            state.message = 'Local storage is full. The index is available in this tab only.';
            if (this.activeId === id) this.onChange();
          }
        });
      }, 600);
    }

    status() {
      const count = this.state?.entries.size || 0;
      if (this.loading) return 'Loading saved index…';
      if (this.busy) return `${this.operation.type === 'scan' ? 'Loading history' : 'Locating prompt'}… ${count} prompts indexed`;
      return this.state?.message || `${count} prompts indexed. Load history to include older prompts.`;
    }

    valid(operation) {
      return this.operation === operation && !operation.cancelled && operation.id === this.conversationId();
    }

    cancel(notify = true) {
      if (!this.operation) return;
      this.operation.cancelled = true;
      this.operation = null;
      if (this.state) this.state.message = 'Stopped. Prompts already indexed have been kept.';
      if (notify) this.onChange();
    }

    start(type, duration = this.maxDuration) {
      this.cancel(false);
      const operation = { type, id: this.activeId, cancelled: false, deadline: Date.now() + duration };
      this.operation = operation;
      this.state.message = '';
      this.onChange();
      return operation;
    }

    refresh(operation) {
      if (!this.valid(operation)) return false;
      this.onChange();
      return Date.now() < operation.deadline;
    }

    findMounted(entry) {
      return this.readMessages().find((candidate) => {
        const current = this.metadata(candidate, null);
        return entry.nativeId ? current.nativeId === entry.nativeId : candidate.id === entry.id;
      })?.element;
    }

    scroll(scroller, top) {
      scroller.scrollTop = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
      // Lazy pagination may wait for a scroll even when already at an edge.
      scroller.dispatchEvent(new Event('scroll'));
      if (scroller === document.scrollingElement) window.dispatchEvent(new Event('scroll'));
    }

    scanState(scroller) {
      return [
        scroller.scrollTop,
        scroller.scrollHeight,
        this.state.entries.size,
        this.lastNativeSignature,
        scroller.querySelector('[aria-busy="true"]') ? 'busy' : 'idle'
      ].join(':');
    }

    async waitForScanStep(scroller, operation, before, edge,
      stepDelay = this.stepDelay, boundaryDelay = this.boundaryDelay) {
      const timeout = edge ? boundaryDelay : stepDelay;
      const minimum = Math.min(timeout, edge ? this.minBoundaryDelay : this.minStepDelay);
      await pause(minimum);
      if (!this.valid(operation) || this.scanState(scroller) !== before) return;
      const deadline = Date.now() + Math.max(0, timeout - minimum);
      while (this.valid(operation) && Date.now() < deadline) {
        await pause(Math.min(this.pollInterval, Math.max(1, deadline - Date.now())));
        if (!this.valid(operation) || this.scanState(scroller) !== before) return;
      }
    }

    async walk(scroller, direction, operation, target,
      stepDelay = this.stepDelay, boundaryDelay = this.boundaryDelay, maxSteps = 700) {
      this.scanDirection = direction;
      try {
        let stable = 0;
        for (let step = 0; step < maxSteps && this.refresh(operation); step += 1) {
          if (target && this.findMounted(target)) return 'found';
          const before = `${scroller.scrollHeight}:${this.state.entries.size}:${this.lastNativeSignature}`;
          const edge = direction < 0 ? scroller.scrollTop <= 1
            : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
          const waitState = this.scanState(scroller);
          this.scroll(scroller, scroller.scrollTop + direction * Math.max(100, scroller.clientHeight * 0.75));
          await this.waitForScanStep(scroller, operation, waitState, edge, stepDelay, boundaryDelay);
          if (!this.refresh(operation)) return 'interrupted';
          const after = `${scroller.scrollHeight}:${this.state.entries.size}:${this.lastNativeSignature}`;
          const atEdge = direction < 0 ? scroller.scrollTop <= 1
            : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
          stable = edge && atEdge && before === after && !scroller.querySelector('[aria-busy="true"]') ? stable + 1 : 0;
          if (stable >= this.boundaryPasses) return 'boundary';
        }
        return 'interrupted';
      } finally {
        this.scanDirection = 0;
      }
    }

    anchor(scroller) {
      const top = scroller.getBoundingClientRect().top;
      const candidate = this.entries().find((entry) => {
        const node = this.findMounted(entry);
        return node && node.getBoundingClientRect().bottom > top;
      });
      return { id: candidate?.id, offset: candidate ? this.findMounted(candidate).getBoundingClientRect().top - top : 0,
        top: scroller.scrollTop, height: scroller.scrollHeight };
    }

    async restore(scroller, anchor, operation) {
      const entry = this.entries().find((candidate) => candidate.id === anchor.id);
      const top = entry?.position !== null && entry?.position !== undefined
        ? entry.position - anchor.offset : anchor.top + scroller.scrollHeight - anchor.height;
      this.scroll(scroller, top);
      await pause(this.stepDelay);
      if (!this.valid(operation)) return;
      const node = entry && this.findMounted(entry);
      if (node) this.scroll(scroller, scroller.scrollTop + node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset);
    }

    async loadAll() {
      if (this.loading) {
        this.state.loading = false;
        this.state.message = 'Saved index loading was skipped. Load full history is still available.';
      }
      this.sync();
      const scroller = this.getScroller();
      if (this.state.pendingSignature || !scroller || scroller.clientHeight <= 0) {
        this.state.message = 'Wait for the conversation to load, then try again.';
        this.onChange();
        return;
      }
      const anchor = this.anchor(scroller);
      const operation = this.start('scan');
      try {
        const up = await this.walk(scroller, -1, operation);
        const down = this.valid(operation) && up === 'boundary' && this.historyMode !== 'dom-scroll'
          ? await this.walk(scroller, 1, operation)
          : up;
        if (this.historyMode === 'dom-scroll' && this.valid(operation)) this.sync();
        if (!this.valid(operation)) return;
        const complete = up === 'boundary' && down === 'boundary';
        await this.restore(scroller, anchor, operation);
        if (!this.valid(operation)) return;
        this.state.message = complete ? `History scanned. ${this.state.entries.size} prompts indexed.`
          : 'Scan paused at the time limit. Indexed prompts have been kept; load history again to continue.';
      } catch {
        if (this.valid(operation)) this.state.message = 'History loading was interrupted. Indexed prompts have been kept.';
      } finally {
        if (this.valid(operation)) {
          this.operation = null;
          this.persist(this.activeId, this.state);
          this.onChange();
        }
      }
    }

    async locate(entry) {
      const present = this.findMounted(entry);
      if (present) return present;
      this.sync();
      const scroller = this.getScroller();
      if (!scroller || scroller.clientHeight <= 0) {
        this.state.message = 'Open the conversation and load history to locate this prompt.';
        this.onChange();
        return null;
      }
      const operation = this.start('jump', this.locateTimeout);
      try {
        if (entry.position !== null) {
          this.scroll(scroller, entry.position - scroller.clientHeight / 3);
          await pause(this.locateDelay);
          if (!this.refresh(operation)) return null;
        }
        // Stored offsets may shift after pagination or a window resize. Virtual
        // row numbers let us narrow the search before walking the loaded list.
        let low = 0;
        let high = scroller.scrollHeight;
        for (let attempt = 0; attempt < 14 && this.valid(operation) && !this.findMounted(entry); attempt += 1) {
          const rows = this.visibleRowIndexes
            ? this.visibleRowIndexes(scroller)
            : Array.from(scroller.querySelectorAll('.v_list_row'), (row) => row.style.getPropertyValue('--cls').match(/^r-(\d+)-/))
              .filter(Boolean).map((match) => Number(match[1]));
          if (entry.rowIndex === null || !rows.length) break;
          if (entry.rowIndex < Math.min(...rows)) high = scroller.scrollTop;
          else if (entry.rowIndex > Math.max(...rows)) low = scroller.scrollTop;
          else break;
          const next = (low + high) / 2;
          if (Math.abs(next - scroller.scrollTop) < 2) break;
          this.scroll(scroller, next);
          await pause(this.locateDelay);
          if (!this.refresh(operation)) return null;
        }
        if (this.valid(operation) && !this.findMounted(entry)) {
          const up = await this.walk(
            scroller, -1, operation, entry, this.locateDelay, this.locateDelay * 2
          );
          if (this.valid(operation) && up === 'boundary') {
            await this.walk(
              scroller, 1, operation, entry, this.locateDelay, this.locateDelay * 2
            );
          }
        }
        if (!this.valid(operation)) return null;
        const target = this.findMounted(entry);
        this.state.message = target ? '' : 'Prompt not found. Load history and try again.';
        return target || null;
      } finally {
        if (this.valid(operation)) {
          this.operation = null;
          this.onChange();
        }
      }
    }
  }

  globalThis.AIChatHistoryIndex = ChatHistoryIndex;
})();
