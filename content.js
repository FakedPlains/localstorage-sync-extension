/**
 * Content Script
 * 在所有页面运行，但只在用户配置的站点列表中激活同步功能
 * 支持多域名/本地服务共享同一份 localStorage
 */

(function () {
  'use strict';

  const DEBOUNCE_DELAY = 2000;
  let debounceTimer = null;
  let lastSyncTimestamp = 0;
  let isEnabled = false;

  // 检查当前站点是否启用同步
  function checkEnabled() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'CHECK_SITE_ENABLED', url: window.location.href },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          resolve(response && response.enabled);
        }
      );
    });
  }

  // 获取当前 localStorage 的所有数据
  function getAllLocalStorage() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      data[key] = localStorage.getItem(key);
    }
    return data;
  }

  // 将云端数据写入 localStorage
  function writeToLocalStorage(data) {
    localStorage.clear();
    for (const [key, value] of Object.entries(data)) {
      localStorage.setItem(key, value);
    }
  }

  // 上传当前 localStorage 到云端
  function uploadToSync() {
    if (!isEnabled) return;
    const data = getAllLocalStorage();
    if (Object.keys(data).length === 0) return;

    chrome.runtime.sendMessage(
      { type: 'SAVE_TO_SYNC', data },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[LS-Sync] Upload failed:', chrome.runtime.lastError.message);
          return;
        }
        if (response && response.success) {
          lastSyncTimestamp = Date.now();
          console.log('[LS-Sync] Upload successful');
        }
      }
    );
  }

  // 从云端下载数据到 localStorage
  function downloadFromSync() {
    if (!isEnabled) return;

    chrome.runtime.sendMessage(
      { type: 'LOAD_FROM_SYNC' },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[LS-Sync] Download failed:', chrome.runtime.lastError.message);
          return;
        }
        if (response && response.success && response.result) {
          const { data, meta } = response.result;
          const localData = getAllLocalStorage();
          const localKeys = Object.keys(localData);
          const remoteKeys = Object.keys(data);

          if (localKeys.length === 0 && remoteKeys.length > 0) {
            // 本地为空，直接写入
            writeToLocalStorage(data);
            console.log('[LS-Sync] Restored', remoteKeys.length, 'keys from cloud');
            window.location.reload();
          } else if (remoteKeys.length > 0 && meta.timestamp > lastSyncTimestamp) {
            // 云端更新，合并（云端优先）
            const merged = { ...localData, ...data };
            writeToLocalStorage(merged);
            lastSyncTimestamp = meta.timestamp;
            console.log('[LS-Sync] Merged, total keys:', Object.keys(merged).length);
            window.dispatchEvent(new Event('storage'));
          }
        }
      }
    );
  }

  // 防抖上传
  function scheduleUpload() {
    if (!isEnabled) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      uploadToSync();
    }, DEBOUNCE_DELAY);
  }

  // 拦截 localStorage 写操作
  const originalSetItem = Storage.prototype.setItem;
  const originalRemoveItem = Storage.prototype.removeItem;
  const originalClear = Storage.prototype.clear;

  Storage.prototype.setItem = function (key, value) {
    originalSetItem.call(this, key, value);
    if (this === localStorage) {
      scheduleUpload();
    }
  };

  Storage.prototype.removeItem = function (key) {
    originalRemoveItem.call(this, key);
    if (this === localStorage) {
      scheduleUpload();
    }
  };

  Storage.prototype.clear = function () {
    originalClear.call(this);
    if (this === localStorage) {
      scheduleUpload();
    }
  };

  // 监听其他标签页的 storage 事件
  window.addEventListener('storage', (event) => {
    if (event.storageArea === localStorage) {
      scheduleUpload();
    }
  });

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SYNC_DATA_UPDATED') {
      downloadFromSync();
    }
    if (message.type === 'FORCE_UPLOAD') {
      uploadToSync();
      sendResponse({ success: true });
    }
    if (message.type === 'FORCE_DOWNLOAD') {
      downloadFromSync();
      sendResponse({ success: true });
    }
    if (message.type === 'CLEAR_LOCAL_STORAGE') {
      localStorage.clear();
      console.log('[LS-Sync] Local storage cleared');
      sendResponse({ success: true });
      return true;
    }
    if (message.type === 'GET_LOCAL_STATUS') {
      const data = getAllLocalStorage();
      sendResponse({
        keyCount: Object.keys(data).length,
        size: new Blob([JSON.stringify(data)]).size,
        origin: window.location.origin
      });
      return true;
    }
  });

  // 初始化：检查当前站点是否启用
  async function init() {
    isEnabled = await checkEnabled();
    if (isEnabled) {
      console.log('[LS-Sync] Active on:', window.location.origin);
      // 页面加载后从云端拉取
      setTimeout(downloadFromSync, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
