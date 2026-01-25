/**
 * AI Assistant Plus - 性能优化最终版 (修复豆包图片识别)
 * 1. 修正了过早剪枝导致豆包图片失效的问题
 * 2. 严格保留原有选择器框架与去重逻辑
 * 3. 引入 Debounce (防抖) 机制优化渲染性能
 */

(function() {
    'use strict';

    let aiData = { customTitles: {}, importantIds: [] };
    let searchQuery = ""; 
    let renderTimer = null; 

    const getConvId = () => {
        const match = window.location.href.match(/(chat|app)\/([a-zA-Z0-9_-]+)/);
        return match ? match[2] : "default_session";
    };

    function getMessageBlocks() {
        const hostname = window.location.hostname;
        let candidates = [];

        if (hostname.includes('doubao.com')) {
            const allPossibleUserBlocks = document.querySelectorAll('div[data-role="user"], [class*="user_message"], [class*="user_content"]');
            candidates = Array.from(allPossibleUserBlocks);

            if (candidates.length === 0) {
                candidates = Array.from(document.querySelectorAll('div')).filter(el => {
                    // 修正：即便 innerText 为空，只要有子节点（可能是图片），也必须检测样式
                    if (el.children.length === 0) return false;
                    const style = window.getComputedStyle(el);
                    return (style.justifyContent === 'flex-end' || style.textAlign === 'right');
                });
            }
        } else {
            candidates = Array.from(document.querySelectorAll('h2, m-user-query, .query-text, [data-test-id="user-query"]'));
        }

        const uniqueBlocks = [];
        const seenTexts = new Set();

        candidates.forEach(el => {
            const hasImg = el.querySelector('img') || el.querySelector('canvas') || el.innerHTML.includes('<img');
            let text = el.innerText ? el.innerText.trim() : "";

            let isPurePic = false;
            if (hasImg && text.length < 2) {
                isPurePic = true;
                text = "___PURE_IMAGE_PLACEHOLDER___"; 
            } else if (hasImg && text.length >= 2) {
                text = `🖼️ ${text}`;
            }

            if (text.length > 0) {
                // 指纹逻辑
                const fingerprint = isPurePic ? `img_at_${el.offsetTop}_${el.offsetLeft}` : text.substring(0, 50);
                
                if (!seenTexts.has(fingerprint)) {
                    const isNested = uniqueBlocks.some(parent => parent.contains(el));
                    const isParentOfExisting = uniqueBlocks.some((existing, index) => {
                        if (el.contains(existing)) {
                            uniqueBlocks[index] = el; 
                            return true;
                        }
                        return false;
                    });

                    if (!isNested && !isParentOfExisting) {
                        el._processedText = text; 
                        uniqueBlocks.push(el);
                        seenTexts.add(fingerprint);
                    }
                }
            }
        });

        let finalPicCount = 0;
        uniqueBlocks.forEach(block => {
            if (block._processedText === "___PURE_IMAGE_PLACEHOLDER___") {
                finalPicCount++;
                block._processedText = `Picture ${finalPicCount}`;
            }
        });

        return uniqueBlocks;
    }

    function renderList() {
        const container = document.getElementById('bookmark-container');
        if (!container) return;
        
        const blocks = getMessageBlocks();
        if (blocks.length === container.childElementCount && !window.forceUpdate && !searchQuery) return;
        
        window.forceUpdate = false;
        container.innerHTML = '';

        blocks.forEach((block, i) => {
            const uniqueId = `${getConvId()}-item-${i}`;
            const isImp = aiData.importantIds.includes(uniqueId);
            const textContent = block._processedText || block.innerText.trim();
            const title = aiData.customTitles[uniqueId] || (textContent.substring(0, 22) + (textContent.length > 22 ? "..." : ""));

            if (searchQuery && !title.toLowerCase().includes(searchQuery.toLowerCase())) return;

            const item = document.createElement('div');
            item.className = `bookmark-item ${isImp ? 'important' : ''}`;
            item.innerHTML = `
                <div class="item-text">${title}</div>
                <div class="item-actions">
                    <span class="action-btn edit-btn">✏️</span>
                    <span class="action-btn mark-btn">${isImp ? '⭐' : '☆'}</span>
                </div>`;

            item.onclick = (e) => {
                if (e.target.classList.contains('action-btn')) return;
                let target = block;
                if (!target.isConnected) {
                    target = Array.from(getMessageBlocks()).find(b => (b._processedText || b.innerText.trim()) === textContent) || block;
                }
                const rect = target.getBoundingClientRect();
                let scroller = target.parentElement;
                while (scroller && scroller !== document.body) {
                    const style = window.getComputedStyle(scroller);
                    if (style.overflowY === 'auto' || style.overflowY === 'scroll') break;
                    scroller = scroller.parentElement;
                }
                if (!scroller || scroller === document.body) {
                    const targetScrollTop = window.scrollY + rect.top - (window.innerHeight / 2) + 80;
                    window.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
                } else {
                    scroller.scrollTo({ top: scroller.scrollTop + rect.top - (scroller.clientHeight / 2) + 80, behavior: 'smooth' });
                }
                target.classList.add('jump-highlight');
                setTimeout(() => target.classList.remove('jump-highlight'), 2500);
            };

            item.querySelector('.edit-btn').onclick = (e) => {
                e.stopPropagation();
                const t = prompt("Rename item:", title);
                if(t) { aiData.customTitles[uniqueId] = t; saveData(); }
            };
            item.querySelector('.mark-btn').onclick = (e) => {
                e.stopPropagation();
                if(isImp) aiData.importantIds = aiData.importantIds.filter(id => id !== uniqueId);
                else aiData.importantIds.push(uniqueId);
                saveData();
            };
            container.appendChild(item);
        });
    }

    function syncAndRender() {
        chrome.storage.local.get(['aiData'], (res) => {
            if(res.aiData) aiData = res.aiData;
            if (!document.getElementById('ai-bookmark-panel')) {
                const panel = document.createElement('div');
                panel.id = 'ai-bookmark-panel'; panel.className = 'collapsed';
                panel.innerHTML = `
                    <div id="ai-nav-toggle">Nav</div>
                    <div class="search-wrapper">
                        <input type="text" id="ai-search-input" placeholder="Search prompts..." autocomplete="off">
                    </div>
                    <div class="panel-content" id="bookmark-container"></div>`;
                document.body.appendChild(panel);
                document.getElementById('ai-nav-toggle').onclick = () => panel.classList.toggle('collapsed');
                const searchInput = document.getElementById('ai-search-input');
                searchInput.oninput = (e) => {
                    searchQuery = e.target.value.trim();
                    renderList();
                };
            }
            renderList();
        });
    }

    function saveData() { window.forceUpdate = true; chrome.storage.local.set({ aiData }, renderList); }

    function bootstrap() {
        syncAndRender();
        const observer = new MutationObserver((mutations) => {
            const hasAddedNodes = mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0);
            if (hasAddedNodes) {
                if (renderTimer) clearTimeout(renderTimer);
                renderTimer = setTimeout(() => { renderList(); }, 300); 
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    bootstrap();
})();