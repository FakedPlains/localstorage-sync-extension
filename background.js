/**
 * Background Service Worker
 * 负责在 chrome.storage.sync 和 content script 之间协调数据同步
 * 支持多域名/本地服务共享同一份 localStorage 数据
 */

const SYNC_KEY_PREFIX = 'ls_chunk_';
const META_KEY = 'ls_meta';
const CONFIG_KEY = 'ls_config';
const CHUNK_SIZE = 4000;
const MAX_TOTAL_SIZE = 102400; // 100KB

// 默认配置
const DEFAULT_CONFIG = {
  // 启用同步的域名列表（支持通配符模式）
  enabledSites: [
    'https://pokemon-localdex.pages.dev',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173'
  ]
};

// 获取配置
async function getConfig() {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  return result[CONFIG_KEY] || DEFAULT_CONFIG;
}

// 保存配置
async function saveConfig(config) {
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
}

// 检查 URL 是否在启用列表中
async function isSiteEnabled(url) {
  if (!url) return false;
  const config = await getConfig();
  const origin = new URL(url).origin;
  return config.enabledSites.some(site => {
    // 精确匹配 origin
    if (site === origin) return true;
    // 支持通配符 * 匹配
    const pattern = site.replace(/\*/g, '.*');
    return new RegExp('^' + pattern + '$').test(origin);
  });
}

// 将大数据分块存储
function chunkData(jsonString) {
  const chunks = [];
  for (let i = 0; i < jsonString.length; i += CHUNK_SIZE) {
    chunks.push(jsonString.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

// 从分块中还原数据
function unchunkData(chunks) {
  return chunks.join('');
}

// 保存 localStorage 数据到 chrome.storage.sync
async function saveToSync(data) {
  const jsonString = JSON.stringify(data);
  const totalSize = new TextEncoder().encode(jsonString).length;

  if (totalSize > MAX_TOTAL_SIZE - 2048) {
    const errMsg = `数据过大 (${(totalSize / 1024).toFixed(1)}KB)，超过 100KB 限制`;
    console.warn('[LS-Sync] ' + errMsg);
    return { success: false, error: errMsg };
  }

  const chunks = chunkData(jsonString);

  // 检查分块数是否超过 chrome.storage.sync 的 512 个 key 上限
  if (chunks.length > 500) {
    const errMsg = `数据分块过多 (${chunks.length} 块)，超过存储上限`;
    console.warn('[LS-Sync] ' + errMsg);
    return { success: false, error: errMsg };
  }

  try {
    // 清除旧的分块
    const oldMeta = await chrome.storage.sync.get(META_KEY);
    if (oldMeta[META_KEY]) {
      const oldChunkCount = oldMeta[META_KEY].chunkCount || 0;
      const keysToRemove = [];
      for (let i = 0; i < oldChunkCount; i++) {
        keysToRemove.push(SYNC_KEY_PREFIX + i);
      }
      if (keysToRemove.length > 0) {
        await chrome.storage.sync.remove(keysToRemove);
      }
    }

    // 写入新的分块
    const writeOps = {};
    for (let i = 0; i < chunks.length; i++) {
      writeOps[SYNC_KEY_PREFIX + i] = chunks[i];
    }
    writeOps[META_KEY] = {
      chunkCount: chunks.length,
      timestamp: Date.now(),
      size: totalSize,
      keyCount: Object.keys(data).length
    };

    await chrome.storage.sync.set(writeOps);
    console.log('[LS-Sync] Saved:', Object.keys(data).length, 'keys,', totalSize, 'bytes');
    return { success: true };
  } catch (err) {
    console.error('[LS-Sync] Save failed:', err);
    return { success: false, error: err.message };
  }
}

// 从 chrome.storage.sync 读取数据
async function loadFromSync() {
  const metaResult = await chrome.storage.sync.get(META_KEY);
  const meta = metaResult[META_KEY];

  if (!meta || !meta.chunkCount) {
    return null;
  }

  const chunkKeys = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    chunkKeys.push(SYNC_KEY_PREFIX + i);
  }

  const chunksResult = await chrome.storage.sync.get(chunkKeys);
  const chunks = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const chunk = chunksResult[SYNC_KEY_PREFIX + i];
    if (chunk === undefined) {
      console.error('[LS-Sync] Missing chunk:', i);
      return null;
    }
    chunks.push(chunk);
  }

  const jsonString = unchunkData(chunks);
  try {
    return { data: JSON.parse(jsonString), meta };
  } catch (e) {
    console.error('[LS-Sync] Parse error:', e);
    return null;
  }
}

// 清除云端所有同步数据
async function clearSyncData() {
  const metaResult = await chrome.storage.sync.get(META_KEY);
  const meta = metaResult[META_KEY];

  const keysToRemove = [META_KEY];
  if (meta && meta.chunkCount) {
    for (let i = 0; i < meta.chunkCount; i++) {
      keysToRemove.push(SYNC_KEY_PREFIX + i);
    }
  }

  await chrome.storage.sync.remove(keysToRemove);
  console.log('[LS-Sync] Cloud data cleared');
  return true;
}

// 监听来自 content script 和 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'CHECK_SITE_ENABLED':
      isSiteEnabled(message.url).then(enabled => {
        sendResponse({ enabled });
      });
      return true;

    case 'SAVE_TO_SYNC':
      saveToSync(message.data).then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;

    case 'LOAD_FROM_SYNC':
      loadFromSync().then(result => {
        sendResponse({ success: true, result });
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;

    case 'GET_SYNC_STATUS':
      chrome.storage.sync.get(META_KEY).then(result => {
        sendResponse({ meta: result[META_KEY] || null });
      }).catch(err => {
        sendResponse({ meta: null, error: err.message });
      });
      return true;

    case 'GET_CONFIG':
      getConfig().then(config => {
        sendResponse({ config });
      });
      return true;

    case 'SAVE_CONFIG':
      saveConfig(message.config).then(() => {
        sendResponse({ success: true });
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;

    case 'CLEAR_SYNC_DATA':
      clearSyncData().then(success => {
        sendResponse({ success });
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
  }
});

// 监听 chrome.storage.sync 的变化（来自其他设备的同步）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (!changes[META_KEY]) return;

  // 通知所有启用的标签页
  getConfig().then(config => {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (!tab.url) continue;
        try {
          const origin = new URL(tab.url).origin;
          const isEnabled = config.enabledSites.some(site => {
            if (site === origin) return true;
            const pattern = site.replace(/\*/g, '.*');
            return new RegExp('^' + pattern + '$').test(origin);
          });
          if (isEnabled) {
            chrome.tabs.sendMessage(tab.id, { type: 'SYNC_DATA_UPDATED' }).catch(() => {});
          }
        } catch (e) {}
      }
    });
  });
});
