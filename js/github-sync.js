/**
 * 网址导航 - GitHub 数据同步引擎
 *
 * 设计目标：把"用户产生的数据"（书签、分组）直接提交到页面所在的 GitHub 仓库，
 * 实现真正的持久化与多端一致 —— 换设备打开同一个 Pages 地址即可拿到最新数据。
 *
 * 同步模型：
 *   - 仓库配置文件 js/github-config.js 提供 owner/repo/branch/path（公开信息）
 *   - Personal Access Token 只存在本机 localStorage，永不进入仓库
 *   - 无 Token 时通过 raw.githubusercontent.com 只读拉取（公共仓库无需鉴权）
 *   - 有 Token 时通过 GitHub Contents API 读写，写入带 sha 校验
 *   - 用"上次同步内容的哈希"判断本地/云端谁变了，双方都变才提示冲突
 *
 * 依赖 script.js 暴露的全局函数：
 *   collectButtonsFromDOM / parseButtonsText / generateExportText / loadButtons / showNotification
 */
(function (global) {
  'use strict';

  // ==================== 常量 ====================

  var STORAGE_KEYS = {
    config: 'navGitHubConfig',
    token: 'navGitHubToken',
    meta: 'navGitHubMeta'
  };

  var DEFAULTS = {
    owner: '',
    repo: '',
    branch: 'main',
    path: 'buttons.txt',
    autoSync: true,
    token: '',        // 内嵌凭据（部署时由 GitHub 助手写入）
    endpoint: '',     // 中转服务地址（有值时优先使用，页面不含凭据）
    proxyKey: ''      // 中转服务访问口令
  };

  var SAVE_DEBOUNCE = 1200;      // 编辑后延迟提交，合并连续改动
  var POLL_INTERVAL = 60000;     // 轮询云端变化的间隔
  var API_BASE = 'https://api.github.com';
  var RAW_BASE = 'https://raw.githubusercontent.com';

  // ==================== 模块状态 ====================

  var config = Object.assign({}, DEFAULTS);
  var token = '';
  var meta = { sha: null, syncedHash: '', lastSyncAt: null };

  var busy = false;
  var queued = false;
  var saveTimer = null;
  var pollTimer = null;

  var status = 'idle';           // idle | readonly | syncing | synced | error | conflict
  var statusMessage = '';
  var conflictRemote = null;     // 冲突时暂存云端快照
  var initialized = false;

  // ==================== 工具函数 ====================

  function SyncError(type, message) {
    this.name = 'SyncError';
    this.type = type;
    this.message = message || '同步失败';
  }
  SyncError.prototype = Object.create(Error.prototype);

  function isConfigured() {
    if (config.endpoint) return true;      // 中转服务模式不需要 owner/repo
    return !!(config.owner && config.repo && config.path);
  }

  /** 是否使用中转服务（页面里不出现任何 Token） */
  function useProxy() {
    return !!config.endpoint;
  }

  /** 能否写入：中转服务 或 有 Token 都行 */
  function canWrite() {
    return useProxy() || !!token;
  }

  /** 凭据来源，用于界面提示 */
  function credentialLabel() {
    if (useProxy()) return '中转服务';
    if (!token) return '只读（未配置凭据）';
    if (localStorage.getItem(STORAGE_KEYS.token)) return '本机 Token';
    return '内嵌凭据（部署时写入）';
  }

  function isJsonPath() {
    return /\.json$/i.test(config.path || '');
  }

  /** FNV-1a 32 位哈希，用于判断内容是否变化 */
  function hash(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8) + '-' + text.length;
  }

  function encodeBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function decodeBase64(b64) {
    var clean = String(b64 || '').replace(/\s/g, '');
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  /** 路径需要逐段编码，保留 / */
  function encodePath(path) {
    return String(path)
      .split('/')
      .filter(function (seg) { return seg.length > 0; })
      .map(encodeURIComponent)
      .join('/');
  }

  function formatTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function notify(message, type) {
    if (typeof global.showNotification === 'function') {
      global.showNotification(message, type || 'info');
    }
  }

  // ==================== 配置读写 ====================

  function pickNonEmpty() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src || typeof src !== 'object') continue;
      Object.keys(src).forEach(function (key) {
        var value = src[key];
        if (value !== '' && value !== null && value !== undefined) out[key] = value;
      });
    }
    return out;
  }

  /** 从 GitHub Pages 地址推断 owner/repo，做到开箱即用 */
  function detectFromLocation() {
    var host = global.location.hostname || '';
    var match = host.match(/^([^.]+)\.github\.io$/i);
    if (!match) return {};
    var user = match[1];
    var firstSegment = global.location.pathname.split('/').filter(Boolean)[0];
    return {
      owner: user,
      repo: firstSegment || (user + '.github.io')
    };
  }

  function loadStoredConfig() {
    var fromFile = (global.NAV_GITHUB_CONFIG && typeof global.NAV_GITHUB_CONFIG === 'object')
      ? global.NAV_GITHUB_CONFIG : {};
    var stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.config) || '{}') || {};
    } catch (e) {
      stored = {};
    }
    // 优先级：检测到的地址 < 仓库内配置 < 本机保存的配置
    config = Object.assign({}, DEFAULTS, pickNonEmpty(detectFromLocation(), fromFile, stored));
    config.branch = config.branch || 'main';
    config.path = config.path || 'buttons.txt';
    config.autoSync = config.autoSync !== false;
  }

  function persistConfig() {
    localStorage.setItem(STORAGE_KEYS.config, JSON.stringify({
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
      path: config.path,
      autoSync: config.autoSync
    }));
  }

  function loadMeta() {
    try {
      var stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.meta) || '{}') || {};
      meta = {
        sha: stored.sha || null,
        syncedHash: stored.syncedHash || '',
        lastSyncAt: stored.lastSyncAt || null
      };
    } catch (e) {
      meta = { sha: null, syncedHash: '', lastSyncAt: null };
    }
  }

  function persistMeta() {
    localStorage.setItem(STORAGE_KEYS.meta, JSON.stringify(meta));
  }

  // ==================== 数据序列化 ====================

  /** DOM 是数据的唯一真相来源，序列化时优先从 DOM 读取 */
  function localButtons() {
    if (typeof global.collectButtonsFromDOM === 'function') {
      return global.collectButtonsFromDOM();
    }
    try {
      return JSON.parse(localStorage.getItem('buttons') || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function serialize(buttons) {
    if (isJsonPath()) {
      return JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        buttons: buttons
      }, null, 2) + '\n';
    }
    if (typeof global.generateExportText === 'function') {
      return global.generateExportText(buttons);
    }
    return '';
  }

  function deserialize(text) {
    var trimmed = String(text || '').trim();
    if (!trimmed) return {};
    if (trimmed.charAt(0) === '{') {
      try {
        var obj = JSON.parse(trimmed);
        if (obj && obj.buttons && typeof obj.buttons === 'object') return obj.buttons;
      } catch (e) {
        // 落到文本格式解析
      }
    }
    if (typeof global.parseButtonsText === 'function') {
      return global.parseButtonsText(text);
    }
    return {};
  }

  function localText() {
    return serialize(localButtons());
  }

  function countButtons(buttons) {
    return Object.keys(buttons || {}).reduce(function (sum, key) {
      var list = buttons[key];
      return sum + (Array.isArray(list) ? list.length : 0);
    }, 0);
  }

  /** 合并云端与本机数据：按 容器+分组+网址+名称 去重，云端顺序优先 */
  function mergeButtons(remoteButtons, localButtonsData) {
    var seen = {};
    var out = {};
    var keyOf = function (b) {
      return [b.container || '', b.group || '', b.url || '', b.name || ''].join('\u0001');
    };
    var push = function (tabId, list) {
      if (!Array.isArray(list)) return;
      if (!out[tabId]) out[tabId] = [];
      list.forEach(function (b) {
        if (!b || !b.url) return;
        var k = keyOf(b);
        if (seen[k]) return;
        seen[k] = true;
        out[tabId].push(b);
      });
    };
    Object.keys(remoteButtons || {}).forEach(function (tabId) { push(tabId, remoteButtons[tabId]); });
    Object.keys(localButtonsData || {}).forEach(function (tabId) { push(tabId, localButtonsData[tabId]); });
    return out;
  }

  // ==================== GitHub API ====================

  function apiHeaders() {
    var headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
  }

  function contentsUrl(withRef) {
    var base = API_BASE + '/repos/' + encodeURIComponent(config.owner) + '/' + encodeURIComponent(config.repo) +
      '/contents/' + encodePath(config.path);
    return withRef ? base + '?ref=' + encodeURIComponent(config.branch) : base;
  }

  function rawUrl() {
    return RAW_BASE + '/' + encodeURIComponent(config.owner) + '/' + encodeURIComponent(config.repo) +
      '/' + encodeURIComponent(config.branch) + '/' + encodePath(config.path) + '?t=' + Date.now();
  }

  // ==================== 中转服务（页面内无凭据） ====================

  function proxyHeaders() {
    var headers = { 'Accept': 'application/json' };
    if (config.proxyKey) headers['X-Nav-Key'] = config.proxyKey;
    return headers;
  }

  function proxyMeta() {
    return { owner: config.owner, repo: config.repo, path: config.path, branch: config.branch };
  }

  async function proxyGet() {
    var sep = config.endpoint.indexOf('?') > -1 ? '&' : '?';
    var url = config.endpoint + sep + 'action=get&t=' + Date.now();
    var res = await fetch(url, { headers: proxyHeaders(), cache: 'no-store' });
    if (res.status === 401 || res.status === 403) throw new SyncError('auth', '中转服务拒绝访问（口令不正确？）');
    if (res.status === 404) return { exists: false, sha: null, text: '' };
    if (!res.ok) throw new SyncError('api', '中转服务读取失败（HTTP ' + res.status + '）');
    var data = await res.json();
    return { exists: !!data.exists, sha: data.sha || null, text: data.text || '' };
  }

  async function proxyPut(text, sha) {
    var res = await fetch(config.endpoint, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, proxyHeaders()),
      body: JSON.stringify({
        action: 'put',
        text: text,
        sha: sha || null,
        message: 'nav: 更新网址数据 (' + formatTime(new Date().toISOString()) + ')',
        meta: proxyMeta()
      })
    });
    var data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (res.status === 409) throw new SyncError('conflict', '云端文件已被其他设备更新');
    if (res.status === 401 || res.status === 403) throw new SyncError('auth', '中转服务拒绝访问（口令不正确？）');
    if (!res.ok) throw new SyncError('api', data.message || ('中转服务提交失败（HTTP ' + res.status + '）'));
    return data.sha || null;
  }

  /** 读取云端数据：中转服务 → API（有 Token）→ raw（只读） */
  async function remoteGet() {
    if (useProxy()) return proxyGet();

    if (token) {
      var res = await fetch(contentsUrl(true) + '&t=' + Date.now(), {
        headers: apiHeaders(),
        cache: 'no-store'
      });
      if (res.status === 404) return { exists: false, sha: null, text: '' };
      if (res.status === 401) throw new SyncError('auth', 'Token 无效或已过期');
      if (res.status === 403) throw new SyncError('auth', 'Token 权限不足（需要 Contents: Read and write）');
      if (!res.ok) throw new SyncError('api', '读取云端失败（HTTP ' + res.status + '）');
      var data = await res.json();
      if (Array.isArray(data)) throw new SyncError('api', '配置的路径是一个目录，请指向具体文件');
      return { exists: true, sha: data.sha, text: decodeBase64(data.content || '') };
    }

    var rawRes = await fetch(rawUrl(), { cache: 'no-store' });
    if (rawRes.status === 404) return { exists: false, sha: null, text: '' };
    if (!rawRes.ok) throw new SyncError('api', '读取云端失败（HTTP ' + rawRes.status + '）');
    return { exists: true, sha: null, text: await rawRes.text() };
  }

  /** 写入云端：中转服务 或 直连 API */
  async function remotePut(text, sha) {
    if (useProxy()) return proxyPut(text, sha);
    if (!token) throw new SyncError('auth', '未配置 Token，无法提交到仓库');

    var body = {
      message: 'nav: 更新网址数据 (' + formatTime(new Date().toISOString()) + ')',
      content: encodeBase64(text),
      branch: config.branch
    };
    if (sha) body.sha = sha;

    var res = await fetch(contentsUrl(false), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
      body: JSON.stringify(body)
    });

    var data = {};
    try { data = await res.json(); } catch (e) { data = {}; }

    if (res.status === 409 || res.status === 422) {
      throw new SyncError('conflict', '云端文件已被其他设备更新');
    }
    if (res.status === 401) throw new SyncError('auth', 'Token 无效或已过期');
    if (res.status === 403) throw new SyncError('auth', 'Token 权限不足（需要 Contents: Read and write）');
    if (res.status === 404) throw new SyncError('api', '仓库或分支不存在，请检查配置');
    if (!res.ok) throw new SyncError('api', data.message || ('提交失败（HTTP ' + res.status + '）'));

    return (data.content && data.content.sha) || null;
  }

  // ==================== 状态与界面 ====================

  var STATUS_MAP = {
    idle:     { icon: '☁️', text: '未同步', cls: 'unlinked',   title: '点击配置 GitHub 数据同步' },
    readonly: { icon: '👁️', text: '只读',   cls: 'need-auth',  title: '已连接仓库但未填 Token：可以读取，不能提交。点击配置' },
    syncing:  { icon: '⏳', text: '同步中', cls: 'syncing',    title: '正在与 GitHub 同步…' },
    synced:   { icon: '✅', text: '已同步', cls: 'linked',     title: '数据已与仓库一致' },
    error:    { icon: '⚠️', text: '同步失败', cls: 'unsupported', title: '同步失败' },
    conflict: { icon: '⚡', text: '待处理', cls: 'need-auth',  title: '云端与本机都有改动，点击处理' }
  };

  function setStatus(next, message) {
    status = next;
    statusMessage = message || '';
    renderStatus();
  }

  function renderStatus() {
    var icon = document.getElementById('fileStatusIcon');
    var text = document.getElementById('fileStatusText');
    var box = document.getElementById('fileStatus');
    var preset = STATUS_MAP[status] || STATUS_MAP.idle;

    if (box && icon && text) {
      box.classList.remove('linked', 'unlinked', 'need-auth', 'unsupported', 'syncing');
      icon.textContent = preset.icon;
      text.textContent = preset.text;
      if (preset.cls) box.classList.add(preset.cls);

      var title = preset.title;
      if (status === 'synced' && meta.lastSyncAt) {
        title = '最近同步：' + formatTime(meta.lastSyncAt) +
          '\n凭据：' + credentialLabel() + '\n点击打开同步设置';
      }
      if (status === 'error' && statusMessage) {
        title = '同步失败：' + statusMessage + '\n点击检查配置';
      }
      if (status === 'idle' && isConfigured()) {
        title = '已配置仓库，点击填写 Token 开始同步';
      }
      box.title = title;
      box.setAttribute('aria-label', 'GitHub 同步状态：' + preset.text);
    }

    renderSettingsStatus();
  }

  function renderSettingsStatus() {
    var dot = document.getElementById('ghStatusDot');
    var label = document.getElementById('ghStatusText');
    var time = document.getElementById('ghStatusTime');
    var cred = document.getElementById('ghCredText');
    if (!dot || !label) return;

    dot.className = 'gh-dot gh-dot-' + status;
    var preset = STATUS_MAP[status] || STATUS_MAP.idle;
    var detail = preset.text;
    if (status === 'error' && statusMessage) detail += '：' + statusMessage;
    label.textContent = detail;
    if (time) {
      time.textContent = meta.lastSyncAt ? '最近同步 ' + formatTime(meta.lastSyncAt) : '';
    }
    if (cred) {
      if (!isConfigured()) {
        cred.textContent = '';
      } else if (useProxy()) {
        cred.textContent = '凭据来源：中转服务（页面内不含 Token） · ' + config.endpoint;
      } else {
        cred.textContent = '凭据来源：' + credentialLabel() +
          (credentialLabel() === '内嵌凭据（部署时写入）' ? '（公开可见，建议只授权本仓库）' : '');
      }
    }
  }

  // ==================== 应用云端数据 ====================

  function reactivateTab() {
    var active = document.querySelector('.tab.active') || document.querySelector('.tab#defaultOpen');
    if (active) active.click();
  }

  function applyButtonsData(buttons) {
    localStorage.setItem('buttons', JSON.stringify(buttons || {}));
    localStorage.setItem('lastModified', new Date().toISOString());
    if (typeof global.loadButtons === 'function') {
      global.loadButtons();
      reactivateTab();
    }
  }

  function markSynced(sha, contentHash) {
    meta = {
      sha: sha || meta.sha || null,
      syncedHash: contentHash || '',
      lastSyncAt: new Date().toISOString()
    };
    persistMeta();
    setStatus(canWrite() ? 'synced' : 'readonly');
  }

  // ==================== 核心同步流程 ====================

  async function push(text, sha, options) {
    var opts = options || {};
    var newSha = await remotePut(text, sha);
    markSynced(newSha, hash(text));
    if (opts.notify) notify('已提交到 GitHub 仓库', 'success');
    return true;
  }

  async function sync(reason) {
    if (!isConfigured()) {
      setStatus('idle');
      if (reason === 'manual') openSettings();
      return false;
    }
    if (busy) {
      queued = true;
      return false;
    }
    if (!canWrite()) {
      setStatus('readonly');
      if (reason === 'manual') {
        notify('当前只能读取云端数据，无法提交修改', 'warning');
        openSettings();
      }
      return false;
    }
    if (global.navigator && global.navigator.onLine === false) {
      setStatus('error', '当前处于离线状态');
      return false;
    }

    busy = true;
    setStatus('syncing');

    try {
      var remote = await remoteGet();
      var text = localText();
      var localHash = hash(text);
      var baseHash = meta.syncedHash || '';
      var manual = reason === 'manual';

      if (!remote.exists) {
        // 仓库里还没有数据文件 → 用本机数据创建
        return await push(text, null, { notify: manual });
      }

      var remoteHash = hash(remote.text);

      if (remoteHash === localHash) {
        markSynced(remote.sha, remoteHash);
        if (manual) notify('本机与云端数据一致', 'success');
        return true;
      }

      if (baseHash && remoteHash === baseHash) {
        // 云端自上次同步后没变 → 直接把本机改动提交上去
        return await push(text, remote.sha, { notify: manual });
      }

      if (baseHash && localHash === baseHash) {
        // 本机没改过，是别的设备改了 → 拉取覆盖本机
        applyButtonsData(deserialize(remote.text));
        markSynced(remote.sha, remoteHash);
        notify('已拉取其他设备提交的最新数据', 'success');
        return true;
      }

      if (!baseHash) {
        // 没有同步基准（首次连接 / 缓存被清空）：先判断能否安全地自动收敛
        var localCount = countButtons(localButtons());
        var remoteCount = countButtons(deserialize(remote.text));
        if (remoteCount === 0) {
          return await push(text, remote.sha, { notify: manual });
        }
        if (localCount === 0) {
          applyButtonsData(deserialize(remote.text));
          markSynced(remote.sha, remoteHash);
          return true;
        }
        // 两边都有数据 → 交给用户决定，避免误覆盖
        conflictRemote = remote;
        setStatus('conflict');
        openConflictDialog();
        return false;
      }

      // 双方都有改动 → 冲突
      conflictRemote = remote;
      setStatus('conflict');
      openConflictDialog();
      return false;
    } catch (error) {
      handleError(error);
      if (error && error.type === 'conflict' && meta.sha) {
        // sha 过期：重新读一次云端，交给下一轮同步判断
        queued = true;
      }
      return false;
    } finally {
      busy = false;
      if (queued) {
        queued = false;
        setTimeout(function () { sync('queued'); }, 300);
      }
    }
  }

  function handleError(error) {
    var message = (error && error.message) || '未知错误';
    setStatus('error', message);
    if (error && error.type === 'auth') {
      notify(message + '，请重新填写 Token', 'error');
    } else if (error && error.type === 'conflict') {
      notify('云端数据已变化，正在重新同步…', 'warning');
    } else {
      notify('同步失败：' + message, 'error');
    }
    console.warn('[NavGitHub] 同步失败:', error);
  }

  /** 本地数据变更后调用（防抖提交） */
  function scheduleSave() {
    if (!isConfigured() || !canWrite()) {
      renderStatus();
      return false;
    }
    if (!config.autoSync) return false;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      sync('auto');
    }, SAVE_DEBOUNCE);
    return true;
  }

  // ==================== 轮询：感知其他设备的修改 ====================

  async function checkRemote() {
    if (!isConfigured() || busy || document.hidden) return;
    if (global.navigator && global.navigator.onLine === false) return;
    if (saveTimer) return; // 本机有未提交改动，交给 sync 处理

    try {
      var remote = await remoteGet();
      if (!remote.exists) return;
      var remoteHash = hash(remote.text);
      if (remoteHash === (meta.syncedHash || '')) return;

      var localHash = hash(localText());
      if (localHash !== (meta.syncedHash || '')) {
        // 本机也有未同步改动 → 让 sync 走冲突判定
        setStatus('conflict');
        return;
      }

      applyButtonsData(deserialize(remote.text));
      markSynced(remote.sha, remoteHash);
      notify('已同步其他设备提交的最新数据', 'success');
    } catch (e) {
      console.warn('[NavGitHub] 轮询失败:', e);
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(checkRemote, POLL_INTERVAL);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkRemote();
    });
    global.addEventListener('online', function () {
      if (isConfigured() && canWrite()) sync('auto');
    });
  }

  // ==================== 设置弹窗 ====================

  function openSettings() {
    var modal = document.getElementById('ghSyncModal');
    if (!modal) return;

    var fields = {
      ghOwner: config.owner,
      ghRepo: config.repo,
      ghBranch: config.branch || 'main',
      ghPath: config.path || 'buttons.txt',
      // 只回填本机填写的 Token；内嵌凭据不显示，避免误以为需要重新填写
      ghToken: localStorage.getItem(STORAGE_KEYS.token) || ''
    };
    Object.keys(fields).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = fields[id] || '';
    });

    var autoEl = document.getElementById('ghAutoSync');
    if (autoEl) autoEl.checked = !!config.autoSync;

    var hint = document.getElementById('ghHint');
    if (hint) {
      hint.textContent = isConfigured()
        ? '数据文件：' + config.owner + '/' + config.repo + ' · ' + (config.branch || 'main') + ' · ' + config.path
        : '填写仓库信息后保存，页面会自动从仓库读取数据；仓库里还没有数据文件时会用当前数据创建。';
    }

    renderSettingsStatus();
    modal.style.display = 'flex';
    setTimeout(function () {
      // 移动端不自动聚焦，避免一打开就弹出软键盘挡住表单
      if (window.innerWidth <= 768) return;
      var focusEl = document.getElementById(isConfigured() ? 'ghToken' : 'ghOwner');
      if (focusEl) focusEl.focus();
    }, 60);
  }

  function closeSettings() {
    var modal = document.getElementById('ghSyncModal');
    if (modal) modal.style.display = 'none';
  }

  async function saveSettings() {
    var owner = (document.getElementById('ghOwner').value || '').trim();
    var repo = (document.getElementById('ghRepo').value || '').trim();
    var branch = (document.getElementById('ghBranch').value || '').trim() || 'main';
    var path = (document.getElementById('ghPath').value || '').trim() || 'buttons.txt';
    var newToken = (document.getElementById('ghToken').value || '').trim();
    var autoSyncEl = document.getElementById('ghAutoSync');

    owner = owner.replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    if (owner.indexOf('/') > -1) {
      var parts = owner.split('/');
      owner = parts[0];
      if (!repo && parts[1]) repo = parts[1];
    }
    path = path.replace(/^\/+/, '');

    if (!owner || !repo) {
      // 中转服务模式下不需要 owner/repo
      if (!config.endpoint) {
        notify('请填写仓库所有者和仓库名称', 'warning');
        return;
      }
    }

    var wasConfigured = isConfigured();
    var changedTarget = !wasConfigured || owner !== config.owner || repo !== config.repo ||
      branch !== config.branch || path !== config.path;

    config.owner = owner;
    config.repo = repo;
    config.branch = branch;
    config.path = path;
    config.autoSync = autoSyncEl ? autoSyncEl.checked : true;
    persistConfig();

    // 本机填写的 Token 优先；清空后回落到部署时内嵌的凭据
    if (newToken) {
      localStorage.setItem(STORAGE_KEYS.token, newToken);
    } else {
      localStorage.removeItem(STORAGE_KEYS.token);
    }
    token = newToken || config.token || '';

    if (changedTarget) {
      meta = { sha: null, syncedHash: '', lastSyncAt: null };
      persistMeta();
    }

    closeSettings();

    if (!canWrite()) {
      setStatus('readonly');
      await pullReadonly(true);
      notify('设置已保存。当前只能读取云端数据', 'info');
      return;
    }

    await initialSync(wasConfigured && !changedTarget);
  }

  /** 保存配置后的第一次对齐：仓库有数据就以云端为准，没有就创建 */
  async function initialSync(silentIfSame) {
    if (!isConfigured() || !canWrite()) return;
    setStatus('syncing');
    try {
      var remote = await remoteGet();
      if (!remote.exists) {
        await push(localText(), null, { notify: true });
        notify('已创建云端数据文件', 'success');
        return;
      }

      var localData = localButtons();
      var remoteData = deserialize(remote.text);
      var localCount = countButtons(localData);
      var same = hash(remote.text) === hash(localText());

      if (same) {
        markSynced(remote.sha, hash(remote.text));
        notify('已连接仓库，数据一致', 'success');
        return;
      }

      if (localCount > 0 && !silentIfSame) {
        var useLocal = confirm(
          '仓库中已有数据（' + countButtons(remoteData) + ' 个按钮），本机有 ' + localCount + ' 个按钮。\n\n' +
          '点击「确定」用本机数据覆盖仓库；\n点击「取消」以仓库数据为准。'
        );
        if (useLocal) {
          await push(localText(), remote.sha, { notify: true });
          return;
        }
      }

      applyButtonsData(remoteData);
      markSynced(remote.sha, hash(remote.text));
      notify('已从仓库载入 ' + countButtons(remoteData) + ' 个按钮', 'success');
    } catch (error) {
      handleError(error);
    }
  }

  /** 无 Token 时的只读拉取 */
  async function pullReadonly(force) {
    if (!isConfigured()) return;
    try {
      var remote = await remoteGet();
      if (!remote.exists) {
        setStatus('readonly');
        return;
      }
      var remoteHash = hash(remote.text);
      var localCount = countButtons(localButtons());
      if (!force && localCount > 0 && meta.syncedHash && remoteHash !== meta.syncedHash) {
        setStatus('readonly');
        return;
      }
      applyButtonsData(deserialize(remote.text));
      markSynced(remote.sha, remoteHash);
      setStatus('readonly');
    } catch (error) {
      setStatus('error', error.message);
    }
  }

  async function manualPull() {
    if (!isConfigured()) {
      notify('请先填写仓库配置', 'warning');
      return;
    }
    setStatus('syncing');
    try {
      var remote = await remoteGet();
      if (!remote.exists) {
        notify('仓库中还没有数据文件', 'warning');
        setStatus(meta.syncedHash ? 'synced' : 'idle');
        return;
      }
      var remoteHash = hash(remote.text);
      var localHash = hash(localText());
      if (remoteHash === localHash) {
        markSynced(remote.sha, remoteHash);
        notify('本机与云端数据一致', 'success');
        return;
      }
      if (localHash !== (meta.syncedHash || '') && localHash !== remoteHash) {
        var ok = confirm('本机有未提交的修改，拉取将覆盖这些修改，确定继续吗？');
        if (!ok) {
          renderStatus();
          return;
        }
      }
      applyButtonsData(deserialize(remote.text));
      markSynced(remote.sha, remoteHash);
      notify('已拉取云端数据', 'success');
    } catch (error) {
      handleError(error);
    }
  }

  async function manualPush() {
    if (!isConfigured()) {
      notify('请先填写仓库配置', 'warning');
      return;
    }
    if (!canWrite()) {
      notify('当前只能读取云端数据，无法提交到仓库', 'warning');
      return;
    }
    await sync('manual');
  }

  // ==================== 冲突处理 ====================

  function openConflictDialog() {
    var modal = document.getElementById('ghConflictModal');
    if (modal) modal.style.display = 'flex';
  }

  function closeConflictDialog() {
    var modal = document.getElementById('ghConflictModal');
    if (modal) modal.style.display = 'none';
  }

  async function resolveConflict(choice) {
    closeConflictDialog();
    var remote = conflictRemote;
    conflictRemote = null;
    if (!remote) {
      setStatus('synced');
      return;
    }

    try {
      if (choice === 'remote') {
        applyButtonsData(deserialize(remote.text));
        markSynced(remote.sha, hash(remote.text));
        notify('已使用云端数据', 'success');
      } else if (choice === 'local') {
        await push(localText(), remote.sha, { notify: true });
        notify('已用本机数据覆盖云端', 'success');
      } else {
        var merged = mergeButtons(deserialize(remote.text), localButtons());
        applyButtonsData(merged);
        var text = serialize(merged);
        await push(text, remote.sha, { notify: true });
        notify('已合并双方数据（共 ' + countButtons(merged) + ' 个按钮）', 'success');
      }
    } catch (error) {
      handleError(error);
    }
  }

  // ==================== 事件绑定与初始化 ====================

  function bindUI() {
    var modal = document.getElementById('ghSyncModal');
    var closeBtn = document.getElementById('ghModalClose');
    var saveBtn = document.getElementById('ghSaveBtn');
    var pullBtn = document.getElementById('ghPullBtn');
    var pushBtn = document.getElementById('ghPushBtn');

    if (closeBtn) closeBtn.addEventListener('click', closeSettings);
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) closeSettings(); });
    if (saveBtn) saveBtn.addEventListener('click', saveSettings);
    if (pullBtn) pullBtn.addEventListener('click', manualPull);
    if (pushBtn) pushBtn.addEventListener('click', manualPush);

    ['ghOwner', 'ghRepo', 'ghBranch', 'ghPath', 'ghToken'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveSettings();
        }
      });
    });

    var conflictModal = document.getElementById('ghConflictModal');
    var conflictClose = document.getElementById('ghConflictClose');
    var btnRemote = document.getElementById('ghConflictRemote');
    var btnLocal = document.getElementById('ghConflictLocal');
    var btnMerge = document.getElementById('ghConflictMerge');

    if (conflictClose) conflictClose.addEventListener('click', function () {
      closeConflictDialog();
      setStatus(meta.lastSyncAt ? 'synced' : 'idle');
    });
    if (conflictModal) conflictModal.addEventListener('click', function (e) {
      if (e.target === conflictModal) {
        closeConflictDialog();
        setStatus(meta.lastSyncAt ? 'synced' : 'idle');
      }
    });
    if (btnRemote) btnRemote.addEventListener('click', function () { resolveConflict('remote'); });
    if (btnLocal) btnLocal.addEventListener('click', function () { resolveConflict('local'); });
    if (btnMerge) btnMerge.addEventListener('click', function () { resolveConflict('merge'); });
  }

  function showFirstRunHint() {
    if (localStorage.getItem('ghHintShown') === 'true') return;
    localStorage.setItem('ghHintShown', 'true');
    setTimeout(function () {
      notify('提示：点击右上角「未同步」可把数据同步到 GitHub 仓库', 'info');
    }, 1500);
  }

  async function init() {
    if (initialized) return;
    initialized = true;

    loadStoredConfig();
    // 本机手动填写的 Token 优先，其次使用部署时内嵌的凭据
    token = localStorage.getItem(STORAGE_KEYS.token) || config.token || '';
    loadMeta();
    bindUI();
    renderStatus();
    startPolling();

    if (!isConfigured()) {
      setStatus('idle');
      showFirstRunHint();
      return;
    }

    if (canWrite()) {
      await sync('init');
    } else {
      await pullReadonly(false);
    }
  }

  // ==================== 对外接口 ====================

  global.NavGitHub = {
    init: init,
    scheduleSave: scheduleSave,
    sync: sync,
    renderStatus: renderStatus,
    openSettings: openSettings,
    pull: manualPull,
    push: manualPush,
    isConfigured: isConfigured,
    getConfig: function () { return Object.assign({}, config); },
    hasToken: function () { return !!token; },
    getStatus: function () { return status; }
  };

})(window);
