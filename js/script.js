/**
 * 网址导航 - 主脚本文件
 * 功能: 按钮管理、拖拽排序、本地缓存、导入导出、本地搜索、触屏交互
 *
 * 数据持久化:
 *   - 运行时数据写在 localStorage（离线可用、秒开）
 *   - 自动保存交给 js/github-sync.js，把数据提交到页面所在的 GitHub 仓库
 *   - 换设备打开同一地址即可拉取最新数据，实现多端一致
 *
 * 交互能力:
 *   - 桌面端: 右键菜单、HTML5 拖拽排序
 *   - 触屏端: 长按菜单、上移/下移排序（触屏不支持 HTML5 拖拽）
 *
 * 右键 / 长按菜单:
 *   - 按钮: 编辑、复制按钮、复制链接、在新标签打开、上移、下移、删除
 *   - 分组标题: 在此分组添加按钮、重命名分组、删除分组
 *   - 分组内空白: 直接弹出添加面板并自动填入分组名
 *   - 内容区空白: 添加按钮、添加分组
 */

// ==================== 配置常量 ====================
const CONFIG = {
  INPUT_PANEL_WIDTH: 320,
  INPUT_PANEL_HEIGHT: 360,
  CONTEXT_MENU_WIDTH: 200,
  CONTEXT_MENU_HEIGHT: 260,
  PANEL_MARGIN: 10,
  SAVE_DEBOUNCE: 500,
  SEARCH_DEBOUNCE: 300,
  LONG_PRESS_DELAY: 480,
  MOBILE_BREAKPOINT: 768,
};

// ==================== 全局状态 ====================
let currentButton = null;
let currentGroupElement = null;
let currentContainerId = 'tab1';
let allButtonsCache = [];
let saveTimeout = null;

// 触屏长按计时器
let longPressTimer = null;
let longPressStart = null;
let longPressTriggered = false;

/**
 * 当前是否处于移动端布局（与 CSS 断点保持一致）
 */
function isMobileLayout() {
  return window.innerWidth <= CONFIG.MOBILE_BREAKPOINT;
}

// ==================== 页面初始化 ====================

window.onload = () => {
  initApplication();
};

async function initApplication() {
  // 1. 先用仓库里的静态 buttons.txt + 本机缓存把页面渲染出来，保证秒开
  try {
    await loadButtonsFromFile();
  } catch (error) {
    console.warn('无法加载 buttons.txt，使用本地缓存数据:', error.message);
  }

  loadButtons();
  initTabListeners();
  initExportImportListeners();
  initLocalSearch();
  initBackToTop();
  initFileManagement();
  initKeyboardShortcuts();
  initTouchInteractions();

  // 默认打开第一个标签页
  const defaultTab = document.querySelector('.tab#defaultOpen');
  if (defaultTab) {
    defaultTab.click();
  }

  updateFileStatus();

  // 2. 再和 GitHub 仓库对齐（拉取最新数据 / 提示配置）
  if (window.NavGitHub) {
    await window.NavGitHub.init();
  }
}

// ==================== 同步状态管理 ====================

function initFileManagement() {
  const fileStatus = document.getElementById('fileStatus');
  const clearStorageButton = document.getElementById('clearStorageButton');
  const syncButton = document.getElementById('syncButton');

  if (fileStatus) {
    fileStatus.addEventListener('click', handleFileStatusClick);
    fileStatus.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleFileStatusClick();
      }
    });
  }

  if (syncButton) {
    syncButton.addEventListener('click', () => {
      if (window.NavGitHub) window.NavGitHub.openSettings();
    });
  }

  if (clearStorageButton) {
    clearStorageButton.addEventListener('click', () => {
      const ok = confirm('确定要清空本机缓存数据吗？\n\n仓库中的云端数据不会被删除，重新打开页面会自动拉取。');
      if (!ok) return;
      localStorage.removeItem('buttons');
      localStorage.removeItem('lastModified');
      localStorage.removeItem('navGitHubMeta');
      location.reload();
    });
  }
}

/**
 * 点击右上角同步状态指示器 → 打开 GitHub 同步设置
 */
function handleFileStatusClick() {
  if (window.NavGitHub) {
    window.NavGitHub.openSettings();
  }
}

/**
 * 统一的数据保存入口
 * 本地：立即写入 localStorage（离线可用）
 * 云端：交给 NavGitHub 防抖提交到 GitHub 仓库
 */
function saveToLinkedFile() {
  if (!window.NavGitHub) return false;
  return window.NavGitHub.scheduleSave();
}

/**
 * 刷新右上角同步状态指示器
 * 具体渲染逻辑在 github-sync.js 中，这里只做转发，避免两处状态不一致
 */
function updateFileStatus() {
  if (window.NavGitHub) {
    window.NavGitHub.renderStatus();
  }
}

// ==================== 数据加载与解析 ====================

/**
 * 用仓库里的 buttons.txt 做"种子数据"
 * 仅在本机还没有缓存时使用，避免覆盖用户已编辑的数据
 */
async function loadButtonsFromFile() {
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem('buttons') || 'null');
  } catch (e) {
    cached = null;
  }
  if (cached && Object.keys(cached).length > 0) return;

  // file:// 协议下 fetch 可能被拦截，静默处理
  const response = await fetch('buttons.txt', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('buttons.txt 文件不存在');
  }
  const text = await response.text();
  if (text.trim()) {
    importButtonsFromText(text);
  }
}

/**
 * 纯解析：文本格式 → 数据对象（不写存储，便于复用）
 */
function parseButtonsText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const buttons = {};
  let currentTabId = '';
  let currentGroup = '';

  lines.forEach(line => {
    line = line.trim();
    if (!line) return;

    if (line.startsWith('Tab:')) {
      currentTabId = line.replace('Tab:', '').trim();
      buttons[currentTabId] = buttons[currentTabId] || [];
    } else if (line.startsWith('Group:')) {
      currentGroup = line.replace('Group:', '').trim();
    } else if (line.startsWith('- URL:') || line.startsWith('- URL:')) {
      const buttonData = parseButtonLine(line);
      if (buttonData && currentTabId) {
        buttons[currentTabId].push({
          ...buttonData,
          group: currentGroup === 'Ungrouped' ? '' : currentGroup,
          container: currentTabId
        });
      }
    }
  });

  return buttons;
}

function importButtonsFromText(text) {
  const buttons = parseButtonsText(text);
  localStorage.setItem('buttons', JSON.stringify(buttons));
}

function parseButtonLine(line) {
  // 移除前导 "- " 或 "  - "
  const cleaned = line.replace(/^\s*-\s*/, '');

  // 按制表符分割各字段
  const parts = cleaned.split('\t').map(part => {
    const index = part.indexOf(': ');
    return index >= 0 ? part.slice(index + 2).trim() : '';
  });

  const [url, name, comment] = parts;
  if (url && name) {
    return { url: url, name, comment: comment || '' };
  }
  return null;
}

// ==================== 标签页管理 ====================

function initTabListeners() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.getAttribute('data-tab');
      updateActiveTab(tab, tabId);
    });
  });
}

function updateActiveTab(tab, tabId) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active');
    hideTabGroups(t.getAttribute('data-tab'));
  });

  tab.classList.add('active');

  document.querySelectorAll('.content').forEach(content => {
    content.style.display = 'none';
  });

  const tabContent = document.getElementById(tabId);
  if (tabContent) {
    tabContent.style.display = 'flex';
  }

  currentContainerId = tabId;
  showTabGroups(tabId);
  showTabSidebarGroups(tabId);
}

function showTabGroups(tabId) {
  document.querySelectorAll(`#${tabId} .group`).forEach(group => {
    group.style.display = 'block';
  });
}

function hideTabGroups(tabId) {
  document.querySelectorAll(`#${tabId} .group`).forEach(group => {
    group.style.display = 'none';
  });
}

function showTabSidebarGroups(tabId) {
  document.querySelectorAll('.tab > .sidebar-group').forEach(group => {
    group.style.display = 'none';
  });
  document.querySelectorAll(`.tab[data-tab="${tabId}"] > .sidebar-group`).forEach(group => {
    group.style.display = 'block';
  });
  // 切换标签后将侧边栏 tab 列表滚动回顶部，确保新标签的子标签从顶部可见
  const sidebarUl = document.querySelector('.sidebar ul');
  if (sidebarUl) sidebarUl.scrollTop = 0;
}

// ==================== 按钮管理 ====================

function loadButtons() {
  // 清空所有内容区域
  document.querySelectorAll('.content').forEach(content => {
    content.innerHTML = '';
  });

  const topSpace = document.getElementById('top-space-1');
  if (topSpace) {
    topSpace.innerHTML = '';
  }

  // 清空所有侧边栏分组
  document.querySelectorAll('.sidebar-group').forEach(group => {
    group.remove();
  });

  const savedButtons = JSON.parse(localStorage.getItem('buttons')) || {};

  for (const [tabId, buttonArray] of Object.entries(savedButtons)) {
    if (!Array.isArray(buttonArray)) continue;
    buttonArray.forEach(buttonData => {
      addButton(
        buttonData.url,
        buttonData.name,
        buttonData.comment,
        tabId,
        false,
        buttonData.group || ''
      );
    });
  }

  updateButtonsCache();
}

function addButton(url, name, comment, containerId, updateStorage = true, group = '') {
  const buttonContainer = document.getElementById(containerId);
  if (!buttonContainer) return;

  let groupElement = null;

  if (group) {
    groupElement = buttonContainer.querySelector(`.group[data-group="${group}"]`);
    if (!groupElement) {
      groupElement = createGroupElement(group, buttonContainer);
    }
  }

  const button = document.createElement('div');
  button.className = 'button';
  button.setAttribute('data-url', url);
  button.setAttribute('data-group', group);
  button.setAttribute('data-container', containerId);
  button.setAttribute('draggable', 'true');
  // 卡片文字会被截断，title 里保留完整信息（桌面悬停 / 移动端长按可看）
  button.title = comment ? `${name}\n${comment}\n${url}` : `${name}\n${url}`;
  button.innerHTML = `
    <div class="name">${escapeHtml(name)}</div>
    <div class="comment">${escapeHtml(comment)}</div>
  `;

  // 点击打开链接（拖拽时不触发）
  button.onclick = (e) => {
    const btn = e.currentTarget;
    if (!btn.hasAttribute('dragging')) {
      window.open(url, '_blank', 'noopener');
    }
  };

  // 插入到正确的容器
  if (groupElement) {
    let buttonsContainer = groupElement.querySelector('.group-buttons-container');
    if (!buttonsContainer) {
      buttonsContainer = createButtonsContainer(groupElement);
    }
    buttonsContainer.appendChild(button);
  } else {
    let buttonsContainer = buttonContainer.querySelector(':scope > .group-buttons-container');
    if (!buttonsContainer) {
      buttonsContainer = createButtonsContainer(buttonContainer);
    }
    buttonsContainer.appendChild(button);
  }

  // 为新按钮绑定拖拽事件
  initDraggableButton(button);

  if (updateStorage) {
    updateLocalStorage();
  }
}

function createGroupElement(group, buttonContainer) {
  const groupElement = document.createElement('div');
  groupElement.className = 'group';
  groupElement.setAttribute('data-group', group);

  const groupNameElement = document.createElement('div');
  groupNameElement.className = 'group-name';
  groupNameElement.textContent = group;
  groupNameElement.onclick = () => {
    groupElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  groupElement.appendChild(groupNameElement);
  buttonContainer.appendChild(groupElement);

  // 在侧边栏添加分组导航
  const tabElement = document.querySelector(`.tab[data-tab="${buttonContainer.id}"]`);

  if (tabElement) {
    const existingGroups = tabElement.querySelectorAll('.sidebar-group');
    let alreadyExists = false;
    existingGroups.forEach(sg => {
      if (sg.textContent === group) alreadyExists = true;
    });

    if (!alreadyExists) {
      const sidebarGroup = document.createElement('div');
      sidebarGroup.className = 'sidebar-group';
      sidebarGroup.textContent = group;
      sidebarGroup.style.display = 'none';
      sidebarGroup.onclick = () => {
        tabElement.click();
        setTimeout(() => {
          groupElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      };
      tabElement.appendChild(sidebarGroup);
    }
  }

  return groupElement;
}

function createButtonsContainer(parentElement) {
  const buttonsContainer = document.createElement('div');
  buttonsContainer.className = 'group-buttons-container';
  parentElement.appendChild(buttonsContainer);
  return buttonsContainer;
}

function updateButton(url, name, comment, group) {
  if (!currentButton) return;

  currentButton.setAttribute('data-url', url);
  currentButton.querySelector('.name').textContent = name;
  currentButton.querySelector('.comment').textContent = comment;
  currentButton.title = comment ? `${name}\n${comment}\n${url}` : `${name}\n${url}`;

  const oldGroup = currentButton.getAttribute('data-group') || '';

  if (oldGroup !== group) {
    const containerId = currentButton.getAttribute('data-container');
    const buttonContainer = document.getElementById(containerId);

    const oldGroupElement = currentButton.closest('.group');
    currentButton.remove();

    // 清理空的旧分组
    if (oldGroupElement) {
      const oldButtonsContainer = oldGroupElement.querySelector('.group-buttons-container');
      if (oldButtonsContainer && oldButtonsContainer.children.length === 0) {
        removeSidebarGroup(oldGroup, containerId);
        oldGroupElement.remove();
      }
    }

    currentButton.setAttribute('data-group', group);

    if (group) {
      let newGroupElement = buttonContainer.querySelector(`.group[data-group="${group}"]`);
      if (!newGroupElement) {
        newGroupElement = createGroupElement(group, buttonContainer);
      }
      let buttonsContainer = newGroupElement.querySelector('.group-buttons-container');
      if (!buttonsContainer) {
        buttonsContainer = createButtonsContainer(newGroupElement);
      }
      buttonsContainer.appendChild(currentButton);
    } else {
      let buttonsContainer = buttonContainer.querySelector(':scope > .group-buttons-container');
      if (!buttonsContainer) {
        buttonsContainer = createButtonsContainer(buttonContainer);
      }
      buttonsContainer.appendChild(currentButton);
    }
  }

  currentButton.setAttribute('data-group', group);
}

function deleteButton() {
  if (!currentButton) return;

  const groupElement = currentButton.closest('.group');
  const containerId = currentButton.getAttribute('data-container');
  const groupName = currentButton.getAttribute('data-group') || '';

  currentButton.remove();

  // 清理空的分组
  if (groupElement) {
    const buttonsContainer = groupElement.querySelector('.group-buttons-container');
    if (buttonsContainer && buttonsContainer.children.length === 0) {
      groupElement.remove();
      removeSidebarGroup(groupName, containerId);
    }
  }

  updateLocalStorage();
  closeMenus();
}

function removeSidebarGroup(groupName, tabId) {
  if (!groupName) return;

  const tabElement = document.querySelector(`.tab[data-tab="${tabId}"]`);
  if (!tabElement) return;

  tabElement.querySelectorAll('.sidebar-group').forEach(group => {
    if (group.textContent === groupName) {
      group.remove();
    }
  });
}

/**
 * 清理所有空的分组元素
 */
function cleanupEmptyGroups() {
  document.querySelectorAll('.group').forEach(group => {
    const container = group.querySelector('.group-buttons-container');
    if (container && container.children.length === 0) {
      const groupName = group.getAttribute('data-group') || '';
      const tabContent = group.closest('.content');
      const tabId = tabContent ? tabContent.id : '';
      group.remove();
      removeSidebarGroup(groupName, tabId);
    }
  });
}

// ==================== 拖拽功能 ====================

/**
 * 为单个按钮绑定拖拽事件（幂等：重复调用不会重复绑定）
 * 使用 dragStarted 标志避免重复初始化
 */
function initDraggableButton(button) {
  if (button.dataset.dragInitialized === 'true') return;
  button.dataset.dragInitialized = 'true';

  button.setAttribute('draggable', 'true');
  button.addEventListener('dragstart', dragStart);
  button.addEventListener('dragover', dragOver);
  button.addEventListener('dragenter', dragEnter);
  button.addEventListener('dragleave', dragLeave);
  button.addEventListener('drop', drop);
  button.addEventListener('dragend', dragEnd);
}

function dragStart(event) {
  // 使用 currentTarget 确保指向按钮本身而非子元素
  currentButton = event.currentTarget;
  currentButton.setAttribute('dragging', 'true');
  event.dataTransfer.effectAllowed = 'move';

  // Firefox 必须调用 setData 才能触发拖拽
  event.dataTransfer.setData('text/plain', currentButton.getAttribute('data-url') || '');
}

function dragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

function dragEnter(event) {
  const target = event.target.closest('.button');
  if (target && target !== currentButton) {
    target.classList.add('drag-over');
  }
}

function dragLeave(event) {
  const target = event.target.closest('.button');
  if (target) {
    target.classList.remove('drag-over');
  }
}

function drop(event) {
  event.preventDefault();
  const target = event.target.closest('.button');

  // 清除所有拖拽悬停样式
  document.querySelectorAll('.button.drag-over').forEach(b => b.classList.remove('drag-over'));

  if (!currentButton || !target || target === currentButton) return;

  const targetParent = target.parentNode;
  const currentParent = currentButton.parentNode;

  if (targetParent === currentParent) {
    // 同容器内重排序
    const buttons = Array.from(targetParent.children);
    const currentIndex = buttons.indexOf(currentButton);
    const targetIndex = buttons.indexOf(target);

    if (currentIndex < targetIndex) {
      targetParent.insertBefore(currentButton, target.nextSibling);
    } else {
      targetParent.insertBefore(currentButton, target);
    }
  } else {
    // 跨容器/跨分组移动
    targetParent.insertBefore(currentButton, target);

    // 更新按钮的容器和分组属性
    const newContainer = targetParent.closest('.content, #top-space-1');
    if (newContainer) {
      currentButton.setAttribute('data-container', newContainer.id);
    }
    const newGroupElement = targetParent.closest('.group');
    const newGroup = newGroupElement ? newGroupElement.getAttribute('data-group') : '';
    currentButton.setAttribute('data-group', newGroup);

    // 清理可能变空的旧分组
    cleanupEmptyGroups();
  }

  updateLocalStorage();
}

function dragEnd(event) {
  if (currentButton) {
    currentButton.removeAttribute('dragging');
  }
  // 清除所有拖拽悬停样式
  document.querySelectorAll('.button.drag-over').forEach(b => b.classList.remove('drag-over'));
}

// ==================== 本地搜索功能 ====================

/**
 * 打开右侧浮动搜索面板
 */
function openFloatSearchPanel() {
  const panel = document.getElementById('floatSearchPanel');
  const btn = document.getElementById('floatSearchBtn');
  if (!panel || !btn) return;
  panel.classList.add('show');
  btn.classList.add('active');
  setTimeout(() => {
    const input = document.getElementById('localSearchInput');
    if (input) input.focus();
  }, 50);
}

/**
 * 关闭右侧浮动搜索面板
 */
function closeFloatSearchPanel() {
  const panel = document.getElementById('floatSearchPanel');
  const btn = document.getElementById('floatSearchBtn');
  if (!panel || !btn) return;
  panel.classList.remove('show');
  btn.classList.remove('active');
  // 关闭时隐藏结果
  const resultsContainer = document.getElementById('searchResults');
  if (resultsContainer) resultsContainer.style.display = 'none';
}

function initLocalSearch() {
  const searchInput = document.getElementById('localSearchInput');
  const searchBtn = document.getElementById('localSearchBtn');
  const clearBtn = document.getElementById('clearSearchBtn');
  const resultsContainer = document.getElementById('searchResults');
  const floatBtn = document.getElementById('floatSearchBtn');
  const floatClose = document.getElementById('floatSearchClose');

  if (!searchInput || !searchBtn || !clearBtn || !resultsContainer) return;

  // 浮动按钮：点击展开/收起搜索面板
  if (floatBtn) {
    floatBtn.addEventListener('click', () => {
      const panel = document.getElementById('floatSearchPanel');
      if (panel && panel.classList.contains('show')) {
        closeFloatSearchPanel();
      } else {
        openFloatSearchPanel();
      }
    });
  }

  // 关闭按钮
  if (floatClose) {
    floatClose.addEventListener('click', closeFloatSearchPanel);
  }

  searchInput.addEventListener('input', debounce((e) => {
    const query = e.target.value.trim();
    if (query.length > 0) {
      performLocalSearch(query);
      clearBtn.style.display = 'flex';
    } else {
      resultsContainer.innerHTML = '';
      resultsContainer.style.display = 'none';
      clearBtn.style.display = 'none';
    }
  }, CONFIG.SEARCH_DEBOUNCE));

  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      performLocalSearch(searchInput.value.trim());
    }
  });

  searchBtn.addEventListener('click', () => {
    performLocalSearch(searchInput.value.trim());
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    resultsContainer.innerHTML = '';
    resultsContainer.style.display = 'none';
    clearBtn.style.display = 'none';
    clearSearchHighlights();
    searchInput.focus();
  });

  // 点击面板/按钮以外区域时自动收起整个浮动搜索面板
  document.addEventListener('click', (e) => {
    if (!e.target || typeof e.target.closest !== 'function') return;
    const panel = document.getElementById('floatSearchPanel');
    if (panel && panel.classList.contains('show') &&
        !e.target.closest('#floatSearchPanel') && !e.target.closest('#floatSearchBtn')) {
      closeFloatSearchPanel();
    }
  });

  // Escape 键关闭面板
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeFloatSearchPanel();
    }
  });

  searchInput.addEventListener('focus', () => {
    if (resultsContainer.innerHTML) {
      resultsContainer.style.display = 'block';
    }
  });
}

// ==================== 回到顶部功能 ====================

function initBackToTop() {
  const backBtn = document.getElementById('backToTopBtn');
  const mainContent = document.querySelector('.main-content');
  if (!backBtn) return;

  // 点击快速回到视图顶部（同时滚动窗口与主内容区）
  backBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (mainContent) mainContent.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // 滚动时根据位置显示/隐藏按钮
  const toggleVisibility = () => {
    const windowScrolled = window.scrollY > 300;
    const contentScrolled = mainContent ? mainContent.scrollTop > 300 : false;
    if (windowScrolled || contentScrolled) {
      backBtn.classList.add('show');
    } else {
      backBtn.classList.remove('show');
    }
  };

  window.addEventListener('scroll', toggleVisibility, { passive: true });
  if (mainContent) {
    mainContent.addEventListener('scroll', toggleVisibility, { passive: true });
  }
  toggleVisibility();
}

function updateButtonsCache() {
  allButtonsCache = [];

  document.querySelectorAll('.content, #top-space-1').forEach(container => {
    const tabId = container.id;
    const tabName = getTabName(tabId);

    container.querySelectorAll('.button').forEach(button => {
      allButtonsCache.push({
        element: button,
        name: button.querySelector('.name')?.textContent || '',
        comment: button.querySelector('.comment')?.textContent || '',
        url: button.getAttribute('data-url') || '',
        group: button.getAttribute('data-group') || '',
        tabId: tabId,
        tabName: tabName
      });
    });
  });
}

function getTabName(tabId) {
  const tab = document.querySelector(`.tab[data-tab="${tabId}"]`);
  if (tab) {
    const clone = tab.cloneNode(true);
    clone.querySelectorAll('.sidebar-group').forEach(el => el.remove());
    return clone.textContent.trim();
  }
  if (tabId === 'top-space-1') return '顶部快捷';
  return tabId;
}

function performLocalSearch(query) {
  if (!query) return;

  const resultsContainer = document.getElementById('searchResults');
  const lowerQuery = query.toLowerCase();

  updateButtonsCache();

  const results = allButtonsCache.filter(item => {
    return item.name.toLowerCase().includes(lowerQuery) ||
           item.comment.toLowerCase().includes(lowerQuery) ||
           item.url.toLowerCase().includes(lowerQuery) ||
           (item.group && item.group.toLowerCase().includes(lowerQuery));
  });

  if (results.length > 0) {
    resultsContainer.innerHTML = results.map((item, index) => `
      <div class="search-result-item" data-index="${index}">
        <div class="result-name">${highlightMatch(item.name, query)}</div>
        <div class="result-info">
          <span class="result-tab">${escapeHtml(item.tabName)}</span>
          ${item.group ? `<span class="result-group">${escapeHtml(item.group)}</span>` : ''}
        </div>
        <div class="result-comment">${highlightMatch(item.comment, query)}</div>
      </div>
    `).join('');

    resultsContainer.style.display = 'block';

    resultsContainer.querySelectorAll('.search-result-item').forEach((item, index) => {
      item.addEventListener('click', () => {
        navigateToButton(results[index]);
        resultsContainer.style.display = 'none';
      });
    });
  } else {
    resultsContainer.innerHTML = '<div class="no-results">未找到匹配的结果</div>';
    resultsContainer.style.display = 'block';
  }
}

function highlightMatch(text, query) {
  if (!text || !query) return escapeHtml(text || '');

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);

  if (index === -1) return escapeHtml(text);

  const before = text.substring(0, index);
  const match = text.substring(index, index + query.length);
  const after = text.substring(index + query.length);

  return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

function navigateToButton(buttonInfo) {
  clearSearchHighlights();

  const tab = document.querySelector(`.tab[data-tab="${buttonInfo.tabId}"]`);
  if (tab && buttonInfo.tabId !== 'top-space-1') {
    tab.click();
  }

  setTimeout(() => {
    const button = buttonInfo.element;
    if (button) {
      button.scrollIntoView({ behavior: 'smooth', block: 'center' });
      button.classList.add('search-highlight');

      setTimeout(() => {
        button.classList.remove('search-highlight');
      }, 3000);
    }
    // 跳转完成后关闭浮动搜索面板
    closeFloatSearchPanel();
  }, 150);
}

function clearSearchHighlights() {
  document.querySelectorAll('.search-highlight').forEach(el => {
    el.classList.remove('search-highlight');
  });
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// ==================== 存储管理 ====================

/**
 * 从 DOM 收集当前全部按钮数据
 * DOM 是唯一真相来源：顺序、分组、所属标签页都以页面实际状态为准
 */
function collectButtonsFromDOM() {
  const buttons = {};

  document.querySelectorAll('.content, #top-space-1').forEach(container => {
    const tabId = container.id;
    buttons[tabId] = [];

    container.querySelectorAll('.button').forEach(btn => {
      buttons[tabId].push({
        url: btn.getAttribute('data-url'),
        name: btn.querySelector('.name')?.textContent || '',
        comment: btn.querySelector('.comment')?.textContent || '',
        group: btn.getAttribute('data-group') || '',
        container: btn.getAttribute('data-container') || tabId
      });
    });
  });

  return buttons;
}

function updateLocalStorage() {
  const buttons = collectButtonsFromDOM();

  localStorage.setItem('buttons', JSON.stringify(buttons));
  localStorage.setItem('lastModified', new Date().toISOString());

  updateButtonsCache();

  // 防抖保存到 GitHub 仓库
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveToLinkedFile();
  }, CONFIG.SAVE_DEBOUNCE);
}

// ==================== 导入导出功能 ====================

function initExportImportListeners() {
  document.getElementById('exportButton').addEventListener('click', exportLocalStorage);
  document.getElementById('importButton').addEventListener('change', importLocalStorage);
}

function exportLocalStorage() {
  const buttons = JSON.parse(localStorage.getItem('buttons')) || {};
  const exportData = generateExportText(buttons);
  downloadFile(exportData, 'buttons.txt', 'text/plain;charset=UTF-8');
}

function generateExportText(buttons) {
  let exportData = '';

  for (const [tabId, buttonList] of Object.entries(buttons)) {
    if (!buttonList || buttonList.length === 0) continue;

    exportData += `Tab: ${tabId}\n`;

    const groupedButtons = buttonList.reduce((acc, button) => {
      const group = button.group || 'Ungrouped';
      acc[group] = acc[group] || [];
      acc[group].push(button);
      return acc;
    }, {});

    for (const [group, groupButtons] of Object.entries(groupedButtons)) {
      exportData += `Group: ${group}\n`;
      groupButtons.forEach(button => {
        exportData += `  - URL: ${button.url}\tName: ${button.name}\tComment: ${button.comment}\tContainer: ${button.container}\n`;
      });
      exportData += '\n';
    }
    exportData += '\n';
  }

  return exportData;
}

function downloadFile(content, filename, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 延迟释放，确保下载已触发
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importLocalStorage() {
  const file = document.getElementById('importButton').files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(event) {
    try {
      const text = String(event.target.result || '');
      // 同时支持 JSON（{version, buttons}）与旧的文本格式
      let data = null;
      const trimmed = text.trim();
      if (trimmed.charAt(0) === '{') {
        try {
          const obj = JSON.parse(trimmed);
          if (obj && obj.buttons && typeof obj.buttons === 'object') data = obj.buttons;
        } catch (e) {
          data = null;
        }
      }
      if (!data) data = parseButtonsText(text);

      localStorage.setItem('buttons', JSON.stringify(data));
      loadButtons();
      const activeTab = document.querySelector('.tab.active') || document.querySelector('.tab#defaultOpen');
      if (activeTab) activeTab.click();
      showNotification('导入成功！', 'success');
      saveToLinkedFile();
    } catch (error) {
      console.error('导入失败:', error);
      showNotification('导入失败，请检查文件格式', 'error');
    }
  };
  reader.onerror = () => {
    showNotification('读取文件失败', 'error');
  };
  reader.readAsText(file);

  // 重置 input 以便重复导入同一文件
  document.getElementById('importButton').value = '';
}

// ==================== 右键菜单与输入面板 ====================

function calculatePanelPosition(clientX, clientY, panelWidth, panelHeight) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = clientX;
  let top = clientY;

  if (clientX + panelWidth + CONFIG.PANEL_MARGIN > viewportWidth) {
    left = clientX - panelWidth - CONFIG.PANEL_MARGIN;
  }
  if (left < CONFIG.PANEL_MARGIN) {
    left = CONFIG.PANEL_MARGIN;
  }
  if (clientY + panelHeight + CONFIG.PANEL_MARGIN > viewportHeight) {
    top = viewportHeight - panelHeight - CONFIG.PANEL_MARGIN;
  }
  if (top < CONFIG.PANEL_MARGIN) {
    top = CONFIG.PANEL_MARGIN;
  }

  return { left, top };
}

/**
 * 右键事件 - 根据点击位置自动识别上下文（按钮/分组/空白区域）
 */
document.addEventListener('contextmenu', function(event) {
  // 确保 target 是 Element（文本节点/SVG 等可能没有 closest 方法）
  if (!event.target || typeof event.target.closest !== 'function') return;

  // 允许在输入框/文本域中使用原生右键菜单（复制/粘贴等）
  const targetTag = event.target.tagName;
  if (targetTag === 'INPUT' || targetTag === 'TEXTAREA' || event.target.isContentEditable) {
    return;
  }

  // 允许在搜索区域和侧边栏按钮区使用原生右键菜单
  if (event.target.closest('.s-search, #floatSearchPanel, #floatSearchBtn, #backToTopBtn, .sidebar-buttons')) {
    return;
  }

  event.preventDefault();

  const buttonEl = event.target.closest('.button');
  const groupEl = event.target.closest('.group');
  const groupNameEl = event.target.closest('.group-name');
  const contentEl = event.target.closest('.content, #top-space-1');

  if (buttonEl) {
    // 右键点击按钮 → 显示按钮操作菜单
    currentButton = buttonEl;
    currentGroupElement = null;
    const containerId = buttonEl.getAttribute('data-container') || (contentEl ? contentEl.id : currentContainerId);
    currentContainerId = containerId;
    showContextMenu(event.clientX, event.clientY, 'button');
  } else if (groupNameEl && groupEl) {
    // 右键点击分组标题 → 显示分组操作菜单
    currentButton = null;
    currentGroupElement = groupEl;
    const containerId = contentEl ? contentEl.id : currentContainerId;
    currentContainerId = containerId;
    showContextMenu(event.clientX, event.clientY, 'group');
  } else if (groupEl) {
    // 右键点击分组内空白区域 → 直接弹出添加面板并自动填入分组名
    currentButton = null;
    currentGroupElement = groupEl;
    const groupName = groupEl.getAttribute('data-group') || '';
    const containerId = contentEl ? contentEl.id : currentContainerId;
    showInputPanel(event.clientX, event.clientY, containerId, groupName);
  } else if (contentEl) {
    // 右键点击内容区空白处 → 显示空白区域操作菜单
    currentButton = null;
    currentGroupElement = null;
    const containerId = contentEl.id;
    currentContainerId = containerId;
    showContextMenu(event.clientX, event.clientY, 'empty');
  }
});

document.addEventListener('click', function(event) {
  const inputPanel = document.getElementById('inputPanel');
  const contextMenu = document.getElementById('contextMenu');

  if (!inputPanel.contains(event.target) && !contextMenu.contains(event.target)) {
    closeMenus();
  }
});

// 统一的右键菜单动作处理
document.getElementById('contextMenu').addEventListener('click', function(event) {
  if (!event.target || typeof event.target.closest !== 'function') return;
  const item = event.target.closest('.context-menu-item');
  if (!item) return;
  const action = item.dataset.action;
  handleContextMenuAction(action);
});

// 输入面板按钮事件
document.getElementById('addButton').addEventListener('click', addButtonHandler);
document.getElementById('cancelButton').addEventListener('click', () => {
  closeMenus();
  clearInputPanel();
});

/**
 * 根据动作名称执行对应的右键菜单操作
 */
function handleContextMenuAction(action) {
  switch (action) {
    case 'edit':
      editButton();
      break;
    case 'duplicate':
      duplicateButton();
      break;
    case 'copyLink':
      copyButtonLink();
      break;
    case 'openNewTab':
      openInNewTab();
      break;
    case 'moveUp':
      moveButton(-1);
      break;
    case 'moveDown':
      moveButton(1);
      break;
    case 'delete':
      deleteButton();
      break;
    case 'addToGroup':
      addToGroup();
      break;
    case 'renameGroup':
      renameGroup();
      break;
    case 'deleteGroup':
      deleteGroup();
      break;
    case 'addButton':
      showInputPanel(null, null, currentContainerId, '');
      break;
    case 'addGroup':
      addGroup();
      break;
  }
}

// ==================== 按钮操作 ====================

function editButton() {
  if (!currentButton) return;

  document.getElementById('urlInput').value = currentButton.getAttribute('data-url') || '';
  document.getElementById('nameInput').value = currentButton.querySelector('.name').textContent;
  document.getElementById('commentInput').value = currentButton.querySelector('.comment').textContent;
  const group = currentButton.getAttribute('data-group') || '';
  document.getElementById('groupInput').value = group;

  const containerId = currentButton.getAttribute('data-container') || currentContainerId;
  const rect = currentButton.getBoundingClientRect();
  showInputPanel(rect.right, rect.top, containerId, group);
}

/**
 * 复制按钮链接到剪贴板
 */
function copyButtonLink() {
  if (!currentButton) return;
  const url = currentButton.getAttribute('data-url') || '';

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      showNotification('链接已复制: ' + url, 'success');
    }).catch(() => {
      fallbackCopyText(url);
    });
  } else {
    fallbackCopyText(url);
  }
  closeMenus();
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showNotification('链接已复制', 'success');
  } catch (e) {
    showNotification('复制失败，请手动复制', 'error');
  }
  document.body.removeChild(textarea);
}

/**
 * 在新标签页打开按钮链接
 */
function openInNewTab() {
  if (!currentButton) return;
  const url = currentButton.getAttribute('data-url') || '';
  window.open(url, '_blank', 'noopener');
  closeMenus();
}

/**
 * 在当前分组内上移/下移按钮
 * 触屏设备不支持 HTML5 拖拽，用这个动作完成排序
 * @param {number} direction -1 上移，1 下移
 */
function moveButton(direction) {
  if (!currentButton) {
    closeMenus();
    return;
  }

  const button = currentButton;
  const parent = button.parentNode;
  const siblings = Array.from(parent.children).filter(el => el.classList.contains('button'));
  const index = siblings.indexOf(button);
  const target = siblings[index + direction];

  if (!target) {
    showNotification(direction < 0 ? '已经在最前面了' : '已经在最后面了', 'info');
    closeMenus();
    return;
  }

  if (direction < 0) {
    parent.insertBefore(button, target);
  } else {
    parent.insertBefore(target, button);
  }

  updateLocalStorage();
  closeMenus();
  showNotification('已调整顺序', 'success');
}

/**
 * 复制（克隆）当前按钮
 */
function duplicateButton() {
  if (!currentButton) return;
  const url = currentButton.getAttribute('data-url') || '';
  const name = currentButton.querySelector('.name')?.textContent || '';
  const comment = currentButton.querySelector('.comment')?.textContent || '';
  const group = currentButton.getAttribute('data-group') || '';
  const containerId = currentButton.getAttribute('data-container') || currentContainerId;

  addButton(url, name + ' (副本)', comment, containerId, true, group);
  closeMenus();
  showNotification('已复制按钮: ' + name, 'success');
}

function addButtonHandler() {
  const urlInput = document.getElementById('urlInput').value.trim();
  const name = document.getElementById('nameInput').value.trim();
  const comment = document.getElementById('commentInput').value.trim();
  const group = document.getElementById('groupInput').value.trim();

  if (!urlInput || !name) {
    showNotification('请填写网址和按钮名称', 'warning');
    // 抖动提示
    const panel = document.getElementById('inputPanel');
    panel.classList.remove('shake');
    void panel.offsetWidth; // 强制重排以重新触发动画
    panel.classList.add('shake');
    setTimeout(() => panel.classList.remove('shake'), 500);
    return;
  }

  const url = urlInput.startsWith('http://') || urlInput.startsWith('https://')
    ? urlInput
    : 'https://' + urlInput;

  if (currentButton) {
    updateButton(url, name, comment, group);
  } else {
    addButton(url, name, comment, currentContainerId, true, group);
  }

  closeMenus();
  updateLocalStorage();
  clearInputPanel();
}

function clearInputPanel() {
  document.getElementById('urlInput').value = '';
  document.getElementById('nameInput').value = '';
  document.getElementById('commentInput').value = '';
  document.getElementById('groupInput').value = '';
  document.getElementById('panelHint').textContent = '添加按钮';
}

// ==================== 分组操作 ====================

/**
 * 在当前分组中添加按钮（弹出输入面板并自动填入分组名）
 */
function addToGroup() {
  if (!currentGroupElement) return;
  const groupName = currentGroupElement.getAttribute('data-group') || '';
  const containerEl = currentGroupElement.closest('.content, #top-space-1');
  const containerId = containerEl ? containerEl.id : currentContainerId;

  const rect = currentGroupElement.getBoundingClientRect();
  closeMenus();
  setTimeout(() => {
    showInputPanel(rect.right, rect.top, containerId, groupName);
  }, 50);
}

/**
 * 重命名当前分组
 */
function renameGroup() {
  if (!currentGroupElement) return;
  const oldName = currentGroupElement.getAttribute('data-group') || '';
  const newName = prompt('请输入新的分组名称:', oldName);

  if (!newName || !newName.trim() || newName.trim() === oldName) {
    closeMenus();
    return;
  }

  const trimmedName = newName.trim();
  const containerEl = currentGroupElement.closest('.content, #top-space-1');
  const containerId = containerEl ? containerEl.id : '';

  // 检查同名分组是否已存在
  const existing = containerEl ? containerEl.querySelector(`.group[data-group="${trimmedName}"]`) : null;
  if (existing && existing !== currentGroupElement) {
    showNotification('分组名称已存在: ' + trimmedName, 'warning');
    closeMenus();
    return;
  }

  // 更新分组元素属性和标题
  currentGroupElement.setAttribute('data-group', trimmedName);
  const groupNameEl = currentGroupElement.querySelector('.group-name');
  if (groupNameEl) groupNameEl.textContent = trimmedName;

  // 更新分组内所有按钮的 data-group 属性
  currentGroupElement.querySelectorAll('.button').forEach(btn => {
    btn.setAttribute('data-group', trimmedName);
  });

  // 更新侧边栏分组名
  if (containerId) {
    const tabElement = document.querySelector(`.tab[data-tab="${containerId}"]`);
    if (tabElement) {
      tabElement.querySelectorAll('.sidebar-group').forEach(sg => {
        if (sg.textContent === oldName) {
          sg.textContent = trimmedName;
        }
      });
    }
  }

  updateLocalStorage();
  showNotification(`分组已重命名: ${oldName} → ${trimmedName}`, 'success');
  closeMenus();
}

/**
 * 删除当前分组及其所有按钮
 */
function deleteGroup() {
  if (!currentGroupElement) return;
  const groupName = currentGroupElement.getAttribute('data-group') || '';
  const buttonCount = currentGroupElement.querySelectorAll('.button').length;

  if (buttonCount > 0) {
    if (!confirm(`分组「${groupName}」中有 ${buttonCount} 个按钮，确定要删除整个分组吗？\n（分组内的按钮也会被删除）`)) {
      closeMenus();
      return;
    }
  }

  const containerEl = currentGroupElement.closest('.content, #top-space-1');
  const containerId = containerEl ? containerEl.id : '';

  currentGroupElement.remove();

  if (containerId) {
    removeSidebarGroup(groupName, containerId);
  }

  updateLocalStorage();
  showNotification('已删除分组: ' + groupName, 'info');
  closeMenus();
}

/**
 * 添加新分组（不含按钮）
 */
function addGroup() {
  const groupName = prompt('请输入分组名称:');
  if (!groupName || !groupName.trim()) {
    closeMenus();
    return;
  }

  const trimmedName = groupName.trim();
  const container = document.getElementById(currentContainerId);
  if (!container) {
    closeMenus();
    return;
  }

  // 检查分组是否已存在
  const existing = container.querySelector(`.group[data-group="${trimmedName}"]`);
  if (existing) {
    showNotification('分组已存在: ' + trimmedName, 'warning');
    closeMenus();
    return;
  }

  createGroupElement(trimmedName, container);
  updateLocalStorage();
  showNotification('已添加分组: ' + trimmedName, 'success');
  closeMenus();
}

// ==================== 面板显示 ====================

function showContextMenu(clientX, clientY, context) {
  const contextMenu = document.getElementById('contextMenu');

  // 根据上下文显示/隐藏菜单分区
  contextMenu.querySelectorAll('.context-menu-section').forEach(section => {
    section.style.display = section.dataset.context === context ? 'block' : 'none';
  });

  // 根据可见项数量计算菜单实际尺寸（触屏设备菜单项更高）
  const visibleSection = contextMenu.querySelector(`.context-menu-section[data-context="${context}"]`);
  const itemCount = visibleSection ? visibleSection.querySelectorAll('.context-menu-item').length : 0;
  const itemHeight = document.body.classList.contains('touch-device') ? 46 : 38;
  const menuWidth = CONFIG.CONTEXT_MENU_WIDTH;
  const menuHeight = Math.min(itemCount * itemHeight + 12, window.innerHeight - CONFIG.PANEL_MARGIN * 2);

  const position = calculatePanelPosition(clientX, clientY, menuWidth, menuHeight);

  contextMenu.style.left = `${position.left}px`;
  contextMenu.style.top = `${position.top}px`;
  contextMenu.style.display = 'block';
  document.getElementById('inputPanel').style.display = 'none';
}

/**
 * 显示输入面板
 * @param {number|null} clientX - 鼠标X坐标，null时居中显示
 * @param {number|null} clientY - 鼠标Y坐标
 * @param {string} containerId - 目标容器ID
 * @param {string} presetGroup - 预填的分组名（右键分组内时自动填入）
 */
function showInputPanel(clientX = null, clientY = null, containerId = currentContainerId, presetGroup = '') {
  const inputPanel = document.getElementById('inputPanel');
  const mobile = isMobileLayout();

  // 移动端用底部抽屉式布局，不再跟随鼠标坐标
  inputPanel.classList.toggle('panel-centered', mobile);

  if (!mobile && clientX !== null && clientY !== null) {
    const position = calculatePanelPosition(clientX, clientY, CONFIG.INPUT_PANEL_WIDTH, CONFIG.INPUT_PANEL_HEIGHT);
    inputPanel.style.left = `${position.left}px`;
    inputPanel.style.top = `${position.top}px`;
  } else {
    inputPanel.style.left = '';
    inputPanel.style.top = '';
  }

  inputPanel.style.display = 'block';
  document.getElementById('contextMenu').style.display = 'none';
  currentContainerId = containerId;

  // 预填分组名
  document.getElementById('groupInput').value = presetGroup;

  // 更新面板提示
  updatePanelHint(containerId, presetGroup);

  // 更新分组建议列表
  updateGroupDatalist(containerId);

  // 更新提交按钮文字
  const addBtn = document.getElementById('addButton');
  addBtn.textContent = currentButton ? '保存' : '添加';

  document.getElementById('urlInput').focus();
}

/**
 * 更新面板顶部提示文字，显示按钮将添加到哪个标签页/分组
 */
function updatePanelHint(containerId, group = '') {
  const hint = document.getElementById('panelHint');
  const tabName = getTabName(containerId);
  if (currentButton) {
    hint.textContent = `编辑按钮 · ${tabName}${group ? ' / ' + group : ''}`;
  } else if (group) {
    hint.textContent = `添加到：${tabName} / ${group}`;
  } else {
    hint.textContent = `添加到：${tabName}`;
  }
}

/**
 * 更新分组名称的自动补全列表（datalist）
 */
function updateGroupDatalist(containerId) {
  const datalist = document.getElementById('groupList');
  if (!datalist) return;

  const groups = new Set();
  const container = document.getElementById(containerId);
  if (container) {
    container.querySelectorAll('.group').forEach(g => {
      const name = g.getAttribute('data-group');
      if (name) groups.add(name);
    });
  }

  datalist.innerHTML = Array.from(groups).map(g => `<option value="${escapeHtml(g)}">`).join('');
}

function closeMenus() {
  document.getElementById('contextMenu').style.display = 'none';
  document.getElementById('inputPanel').style.display = 'none';
  currentButton = null;
  currentGroupElement = null;
}

// ==================== 触屏交互 ====================

/**
 * 触屏设备没有右键，用"长按"模拟右键菜单
 * - 长按按钮 → 按钮菜单（编辑 / 复制 / 上移 / 下移 / 删除）
 * - 长按分组标题 → 分组菜单
 * - 长按分组空白 → 直接在该分组下添加按钮
 */
function initTouchInteractions() {
  const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (!isTouch) return;

  document.body.classList.add('touch-device');

  document.addEventListener('touchstart', (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('input, textarea, .input-panel, .context-menu, .modal-overlay, .float-search-panel, .sidebar-buttons')) return;

    longPressTriggered = false;
    clearLongPress();
    longPressStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };

    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      const point = longPressStart;
      if (!point) return;
      const handled = openContextMenuAt(point.x, point.y, target);
      if (handled) {
        longPressTriggered = true;
        if (navigator.vibrate) navigator.vibrate(12);
      }
    }, CONFIG.LONG_PRESS_DELAY);
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!longPressTimer || !longPressStart || !e.touches || !e.touches[0]) return;
    const dx = Math.abs(e.touches[0].clientX - longPressStart.x);
    const dy = Math.abs(e.touches[0].clientY - longPressStart.y);
    // 手指移动超过阈值视为滚动，取消长按
    if (dx > 10 || dy > 10) clearLongPress();
  }, { passive: true });

  document.addEventListener('touchend', clearLongPress);
  document.addEventListener('touchcancel', clearLongPress);

  // 长按已弹出菜单时，拦截随后的 click，避免误打开链接或立即关闭菜单
  document.addEventListener('click', (e) => {
    if (longPressTriggered) {
      longPressTriggered = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

function clearLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressStart = null;
}

/**
 * 在指定坐标弹出上下文菜单
 * @returns {boolean} 是否命中了可操作区域
 */
function openContextMenuAt(x, y, target) {
  const buttonEl = target.closest('.button');
  const groupNameEl = target.closest('.group-name');
  const groupEl = target.closest('.group');
  const contentEl = target.closest('.content, #top-space-1');

  if (buttonEl) {
    currentButton = buttonEl;
    currentGroupElement = null;
    currentContainerId = buttonEl.getAttribute('data-container') || (contentEl ? contentEl.id : currentContainerId);
    showContextMenu(x, y, 'button');
    return true;
  }

  if (groupNameEl && groupEl) {
    currentButton = null;
    currentGroupElement = groupEl;
    currentContainerId = contentEl ? contentEl.id : currentContainerId;
    showContextMenu(x, y, 'group');
    return true;
  }

  if (groupEl) {
    currentButton = null;
    currentGroupElement = groupEl;
    showInputPanel(x, y, contentEl ? contentEl.id : currentContainerId, groupEl.getAttribute('data-group') || '');
    return true;
  }

  if (contentEl) {
    currentButton = null;
    currentGroupElement = null;
    currentContainerId = contentEl.id;
    showContextMenu(x, y, 'empty');
    return true;
  }

  return false;
}

// ==================== 键盘快捷键 ====================

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Escape 关闭面板/菜单/弹窗
    if (e.key === 'Escape') {
      const modals = document.querySelectorAll('.modal-overlay');
      for (const modal of modals) {
        if (modal.style.display === 'flex') {
          modal.style.display = 'none';
          return;
        }
      }
      const inputPanel = document.getElementById('inputPanel');
      const contextMenu = document.getElementById('contextMenu');
      if (inputPanel.style.display === 'block' || contextMenu.style.display === 'block') {
        closeMenus();
        return;
      }
      // 关闭搜索结果
      const results = document.getElementById('searchResults');
      if (results.style.display === 'block') {
        results.style.display = 'none';
        return;
      }
      // 关闭浮动搜索面板
      const floatPanel = document.getElementById('floatSearchPanel');
      if (floatPanel && floatPanel.classList.contains('show')) {
        closeFloatSearchPanel();
        return;
      }
    }

    // 在输入面板中按 Enter 提交（groupInput 为最后一个字段）
    if (e.key === 'Enter' && e.target.id === 'groupInput') {
      e.preventDefault();
      addButtonHandler();
    }

    // Ctrl/Cmd + K 打开浮动搜索面板并聚焦输入框
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      openFloatSearchPanel();
    }
  });
}

// ==================== 工具函数 ====================

function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

/**
 * 显示通知（支持类型: info, success, warning, error）
 */
function showNotification(message, type = 'info') {
  const existing = document.querySelector('.notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);

  // 触发动画
  requestAnimationFrame(() => {
    notification.classList.add('show');
  });

  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}
