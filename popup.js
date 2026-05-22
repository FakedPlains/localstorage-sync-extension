/**
 * Popup Script
 * 显示同步状态 + 管理启用站点列表
 */

// === DOM Elements ===
const syncStatusEl = document.getElementById('syncStatus');
const lastSyncEl = document.getElementById('lastSync');
const dataSizeEl = document.getElementById('dataSize');
const keyCountEl = document.getElementById('keyCount');
const currentSiteEl = document.getElementById('currentSite');
const siteActiveEl = document.getElementById('siteActive');
const btnUpload = document.getElementById('btnUpload');
const btnDownload = document.getElementById('btnDownload');
const messageEl = document.getElementById('message');
const siteListEl = document.getElementById('siteList');
const newSiteInput = document.getElementById('newSiteInput');
const btnAddSite = document.getElementById('btnAddSite');

// === Tab Switching ===
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.panel).classList.add('active');
  });
});

// === Helpers ===
function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = 'message show ' + type;
  setTimeout(() => { messageEl.className = 'message'; }, 3000);
}

function formatTime(timestamp) {
  if (!timestamp) return '-';
  const diff = Date.now() - timestamp;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function formatSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(1) + ' KB';
}

// === Status Panel ===
async function loadStatus() {
  // 获取当前标签页信息
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url) {
    try {
      const origin = new URL(tab.url).origin;
      currentSiteEl.textContent = origin.length > 30 ? origin.slice(0, 30) + '...' : origin;

      const response = await chrome.runtime.sendMessage({ type: 'CHECK_SITE_ENABLED', url: tab.url });
      if (response && response.enabled) {
        siteActiveEl.textContent = '已启用';
        siteActiveEl.className = 'status-value ok';
      } else {
        siteActiveEl.textContent = '未启用';
        siteActiveEl.className = 'status-value inactive';
      }
    } catch (e) {
      currentSiteEl.textContent = '-';
      siteActiveEl.textContent = '-';
    }
  }

  // 获取云端同步状态
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATUS' });
    if (response && response.meta) {
      const meta = response.meta;
      syncStatusEl.textContent = '已同步';
      syncStatusEl.className = 'status-value ok';
      lastSyncEl.textContent = formatTime(meta.timestamp);
      dataSizeEl.textContent = formatSize(meta.size);
      dataSizeEl.className = meta.size > 80000 ? 'status-value warn' : 'status-value ok';
      keyCountEl.textContent = meta.keyCount + ' 个';
    } else {
      syncStatusEl.textContent = '暂无数据';
      syncStatusEl.className = 'status-value warn';
    }
  } catch (err) {
    syncStatusEl.textContent = '获取失败';
    syncStatusEl.className = 'status-value error';
  }
}

// === Sync Actions ===
btnUpload.addEventListener('click', async () => {
  btnUpload.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { showMessage('无法获取当前标签页', 'error'); return; }

    const checkResp = await chrome.runtime.sendMessage({ type: 'CHECK_SITE_ENABLED', url: tab.url });
    if (!checkResp || !checkResp.enabled) {
      showMessage('当前站点未启用同步，请在「站点管理」中添加', 'info');
      return;
    }

    await chrome.tabs.sendMessage(tab.id, { type: 'FORCE_UPLOAD' });
    showMessage('上传成功！', 'success');
    setTimeout(loadStatus, 1000);
  } catch (err) {
    showMessage('上传失败: ' + err.message, 'error');
  } finally {
    btnUpload.disabled = false;
  }
});

btnDownload.addEventListener('click', async () => {
  btnDownload.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { showMessage('无法获取当前标签页', 'error'); return; }

    const checkResp = await chrome.runtime.sendMessage({ type: 'CHECK_SITE_ENABLED', url: tab.url });
    if (!checkResp || !checkResp.enabled) {
      showMessage('当前站点未启用同步，请在「站点管理」中添加', 'info');
      return;
    }

    await chrome.tabs.sendMessage(tab.id, { type: 'FORCE_DOWNLOAD' });
    showMessage('下载成功！页面可能需要刷新', 'success');
  } catch (err) {
    showMessage('下载失败: ' + err.message, 'error');
  } finally {
    btnDownload.disabled = false;
  }
});

// === Sites Management ===
async function loadSites() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  const config = response.config;
  renderSiteList(config.enabledSites);
}

function renderSiteList(sites) {
  siteListEl.innerHTML = '';
  sites.forEach((site, index) => {
    const li = document.createElement('li');
    li.className = 'site-item';
    li.innerHTML = `
      <span class="url">${site}</span>
      <button class="btn-danger" data-index="${index}">删除</button>
    `;
    siteListEl.appendChild(li);
  });

  // 绑定删除事件
  siteListEl.querySelectorAll('.btn-danger').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = parseInt(btn.dataset.index);
      const response = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
      const config = response.config;
      config.enabledSites.splice(index, 1);
      await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config });
      loadSites();
    });
  });
}

btnAddSite.addEventListener('click', async () => {
  let site = newSiteInput.value.trim();
  if (!site) return;

  // 简单校验格式
  try {
    const url = new URL(site);
    site = url.origin; // 标准化为 origin
  } catch (e) {
    // 尝试补全协议
    if (!site.startsWith('http')) {
      site = 'http://' + site;
    }
    try {
      const url = new URL(site);
      site = url.origin;
    } catch (e2) {
      showMessage('无效的站点地址', 'error');
      return;
    }
  }

  const response = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  const config = response.config;

  if (config.enabledSites.includes(site)) {
    showMessage('该站点已存在', 'info');
    return;
  }

  config.enabledSites.push(site);
  await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config });
  newSiteInput.value = '';
  loadSites();
});

// Enter 键添加
newSiteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnAddSite.click();
});

// === Init ===
loadStatus();
loadSites();
