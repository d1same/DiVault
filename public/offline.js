/*
 * DiVault offline storage layer.
 *
 * A thin, promise-based IndexedDB wrapper that gives the app an offline
 * source of truth for notes plus a durable outbox of pending mutations.
 * It is intentionally a pure storage/queue layer: it never touches the
 * network, `state`, or the DOM. All sync/reconciliation logic lives in
 * app.js where it has access to api()/state. Loaded as a classic script
 * before app.js and exposed as window.DiVaultOffline.
 */
(function () {
  'use strict';

  const DB_NAME = 'divault_offline';
  const DB_VERSION = 2;
  const STORE_NOTES = 'notes';          // keyPath 'id' — note summaries (state.notes shape)
  const STORE_DETAILS = 'noteDetails';  // keyPath 'id' — full /notes/{id} responses
  const STORE_OUTBOX = 'outbox';        // keyPath 'mutation_id'
  const STORE_META = 'meta';            // keyPath 'key'
  // Generic collection stores for calendar data (events/tasks/calendars), keyPath 'id'.
  const COLLECTION_STORES = ['events', 'tasks', 'calendars'];

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NOTES)) {
          const notes = db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
          notes.createIndex('updated_at', 'updated_at');
          notes.createIndex('category_id', 'category_id');
        }
        if (!db.objectStoreNames.contains(STORE_DETAILS)) {
          db.createObjectStore(STORE_DETAILS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          const outbox = db.createObjectStore(STORE_OUTBOX, { keyPath: 'mutation_id' });
          outbox.createIndex('created_at', 'created_at');
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
        COLLECTION_STORES.forEach(name => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(err => {
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  }

  function tx(storeNames, mode, run) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(storeNames, mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
      transaction.onerror = () => reject(transaction.error);
      try {
        result = run(transaction);
      } catch (err) {
        try { transaction.abort(); } catch (_) {}
        reject(err);
      }
    }));
  }

  function reqAsync(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function getAll(store) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    }));
  }

  function getOne(store, key) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    }));
  }

  // ---- Meta -------------------------------------------------------------

  function getMeta(key, fallback = null) {
    return getOne(STORE_META, key).then(row => (row ? row.value : fallback)).catch(() => fallback);
  }

  function setMeta(key, value) {
    return tx(STORE_META, 'readwrite', transaction => {
      transaction.objectStore(STORE_META).put({ key, value });
    });
  }

  function uuid() {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'x'.repeat(8).replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)) +
      '-' + Date.now().toString(16);
  }

  // Persistent per-device sync identity used as client_id for /api/sync/push.
  let cachedClientId = null;
  function getSyncClientId() {
    if (cachedClientId) return Promise.resolve(cachedClientId);
    const existing = localStorage.getItem('divault_sync_client_id');
    if (existing) { cachedClientId = existing; return Promise.resolve(existing); }
    const created = uuid();
    localStorage.setItem('divault_sync_client_id', created);
    cachedClientId = created;
    return Promise.resolve(created);
  }

  // Monotonically decreasing negative ids for notes created offline.
  function nextTempId() {
    return openDb().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_META, 'readwrite');
      const store = transaction.objectStore(STORE_META);
      const getReq = store.get('temp_id_counter');
      getReq.onsuccess = () => {
        const current = getReq.result ? Number(getReq.result.value) : 0;
        const next = current - 1;
        store.put({ key: 'temp_id_counter', value: next });
        transaction.oncomplete = () => resolve(next);
      };
      getReq.onerror = () => reject(getReq.error);
      transaction.onerror = () => reject(transaction.error);
    }));
  }

  function isTempId(id) {
    return Number(id) < 0;
  }

  // ---- Notes cache ------------------------------------------------------

  function cacheNotes(notes) {
    if (!Array.isArray(notes) || !notes.length) return Promise.resolve();
    return tx(STORE_NOTES, 'readwrite', transaction => {
      const store = transaction.objectStore(STORE_NOTES);
      notes.forEach(note => { if (note && note.id != null) store.put(note); });
    }).catch(() => {});
  }

  function cacheNote(note) {
    if (!note || note.id == null) return Promise.resolve();
    return tx(STORE_NOTES, 'readwrite', transaction => {
      transaction.objectStore(STORE_NOTES).put(note);
    }).catch(() => {});
  }

  function getCachedNotes() {
    return getAll(STORE_NOTES).catch(() => []);
  }

  function removeCachedNote(id) {
    return tx([STORE_NOTES, STORE_DETAILS], 'readwrite', transaction => {
      transaction.objectStore(STORE_NOTES).delete(id);
      transaction.objectStore(STORE_DETAILS).delete(id);
    }).catch(() => {});
  }

  function cacheNoteDetail(detail) {
    if (!detail || !detail.note || detail.note.id == null) return Promise.resolve();
    return tx(STORE_DETAILS, 'readwrite', transaction => {
      transaction.objectStore(STORE_DETAILS).put({ id: detail.note.id, ...detail });
    }).catch(() => {});
  }

  function getCachedNoteDetail(id) {
    return getOne(STORE_DETAILS, id).catch(() => null);
  }

  // Re-key a temp note to its server-assigned id after sync reconciliation.
  function remapNoteId(tempId, realId, realNote, realDetail) {
    return tx([STORE_NOTES, STORE_DETAILS], 'readwrite', transaction => {
      const notes = transaction.objectStore(STORE_NOTES);
      const details = transaction.objectStore(STORE_DETAILS);
      notes.delete(tempId);
      details.delete(tempId);
      if (realNote) notes.put({ ...realNote, id: realId });
      if (realDetail) details.put({ id: realId, ...realDetail });
    }).catch(() => {});
  }

  // ---- Outbox -----------------------------------------------------------

  function getOutbox() {
    return getAll(STORE_OUTBOX)
      .then(rows => rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))))
      .catch(() => []);
  }

  function outboxCount() {
    return openDb().then(db => new Promise((resolve, reject) => {
      const request = db.transaction(STORE_OUTBOX, 'readonly').objectStore(STORE_OUTBOX).count();
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => reject(request.error);
    })).catch(() => 0);
  }

  /*
   * Enqueue a mutation, coalescing rapid autosaves. If an unsent, non-conflicted
   * upsert already exists for the same note (matched by local_id for temp notes,
   * else entity_id), we overwrite its record in place and keep the original
   * mutation_id + created_at + base_updated_at. Keeping mutation_id stable is what
   * makes retries idempotent server-side; keeping base_updated_at anchored to the
   * first edit keeps conflict detection honest.
   */
  function enqueue(mutation) {
    const key = rowKey({ entity_type: mutation.entity_type || 'note', local_id: mutation.local_id, entity_id: mutation.entity_id });
    return openDb().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_OUTBOX, 'readwrite');
      const store = transaction.objectStore(STORE_OUTBOX);
      const allReq = store.getAll();
      let saved;
      allReq.onsuccess = () => {
        const rows = allReq.result || [];
        const existing = mutation.action === 'upsert'
          ? rows.find(row => row.action === 'upsert' && !row.conflict && rowKey(row) === key)
          : null;
        if (existing) {
          saved = { ...existing, record: mutation.record, action: 'upsert', updated_at: new Date().toISOString() };
        } else {
          saved = {
            mutation_id: uuid(),
            entity_type: mutation.entity_type || 'note',
            action: mutation.action,
            entity_id: mutation.entity_id != null ? mutation.entity_id : 0,
            local_id: mutation.local_id != null ? mutation.local_id : null,
            base_updated_at: mutation.base_updated_at || '',
            record: mutation.record || null,
            created_at: new Date().toISOString(),
            attempts: 0,
            conflict: false
          };
        }
        store.put(saved);
      };
      allReq.onerror = () => reject(allReq.error);
      transaction.oncomplete = () => resolve(saved);
      transaction.onerror = () => reject(transaction.error);
    }));
  }

  function rowKey(row) {
    const type = row.entity_type || 'note';
    return row.local_id != null && isTempId(row.local_id) ? `${type}:local:${row.local_id}` : `${type}:entity:${row.entity_id}`;
  }

  function putMutation(row) {
    if (!row || !row.mutation_id) return Promise.resolve();
    return tx(STORE_OUTBOX, 'readwrite', transaction => {
      transaction.objectStore(STORE_OUTBOX).put(row);
    }).catch(() => {});
  }

  function removeMutation(mutationId) {
    return tx(STORE_OUTBOX, 'readwrite', transaction => {
      transaction.objectStore(STORE_OUTBOX).delete(mutationId);
    }).catch(() => {});
  }

  // Remove every queued mutation for a note (used when a never-synced note is deleted).
  function removeOutboxForNote(id) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_OUTBOX, 'readwrite');
      const store = transaction.objectStore(STORE_OUTBOX);
      const allReq = store.getAll();
      allReq.onsuccess = () => {
        (allReq.result || []).forEach(row => {
          if (row.local_id === id || row.entity_id === id) store.delete(row.mutation_id);
        });
      };
      allReq.onerror = () => reject(allReq.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    })).catch(() => {});
  }

  // Rewrite outbox rows still referencing a temp id after reconciliation.
  function reassignOutboxEntityId(tempId, realId) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_OUTBOX, 'readwrite');
      const store = transaction.objectStore(STORE_OUTBOX);
      const allReq = store.getAll();
      allReq.onsuccess = () => {
        (allReq.result || []).forEach(row => {
          if (row.local_id === tempId || row.entity_id === tempId) {
            row.local_id = null;
            row.entity_id = realId;
            if (row.record && (row.record.id === tempId || row.record.id == null)) row.record.id = realId;
            store.put(row);
          }
        });
      };
      allReq.onerror = () => reject(allReq.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    })).catch(() => {});
  }

  // ---- Generic collections (events / tasks / calendars) -----------------

  function cacheCollection(name, items) {
    if (!COLLECTION_STORES.includes(name) || !Array.isArray(items)) return Promise.resolve();
    return tx(name, 'readwrite', transaction => {
      const store = transaction.objectStore(name);
      store.clear(); // authoritative replace on each online load
      items.forEach(item => { if (item && item.id != null) store.put(item); });
    }).catch(() => {});
  }

  function getCollection(name) {
    if (!COLLECTION_STORES.includes(name)) return Promise.resolve([]);
    return getAll(name).catch(() => []);
  }

  function putCollectionItem(name, item) {
    if (!COLLECTION_STORES.includes(name) || !item || item.id == null) return Promise.resolve();
    return tx(name, 'readwrite', transaction => { transaction.objectStore(name).put(item); }).catch(() => {});
  }

  function deleteCollectionItem(name, id) {
    if (!COLLECTION_STORES.includes(name)) return Promise.resolve();
    return tx(name, 'readwrite', transaction => { transaction.objectStore(name).delete(id); }).catch(() => {});
  }

  function remapCollectionId(name, tempId, realId, realItem) {
    if (!COLLECTION_STORES.includes(name)) return Promise.resolve();
    return tx(name, 'readwrite', transaction => {
      const store = transaction.objectStore(name);
      store.delete(tempId);
      if (realItem) store.put({ ...realItem, id: realId });
    }).catch(() => {});
  }

  async function clearAll() {
    cachedClientId = null;
    return tx([STORE_NOTES, STORE_DETAILS, STORE_OUTBOX, STORE_META, ...COLLECTION_STORES], 'readwrite', transaction => {
      transaction.objectStore(STORE_NOTES).clear();
      transaction.objectStore(STORE_DETAILS).clear();
      transaction.objectStore(STORE_OUTBOX).clear();
      transaction.objectStore(STORE_META).clear();
      COLLECTION_STORES.forEach(name => transaction.objectStore(name).clear());
    }).catch(() => {});
  }

  window.DiVaultOffline = {
    available: typeof indexedDB !== 'undefined',
    ready: () => openDb().then(() => true).catch(() => false),
    getSyncClientId,
    nextTempId,
    isTempId,
    // notes cache
    cacheNotes,
    cacheNote,
    getCachedNotes,
    removeCachedNote,
    cacheNoteDetail,
    getCachedNoteDetail,
    remapNoteId,
    // outbox
    enqueue,
    getOutbox,
    outboxCount,
    putMutation,
    removeMutation,
    removeOutboxForNote,
    reassignOutboxEntityId,
    // collections (events/tasks/calendars)
    cacheCollection,
    getCollection,
    putCollectionItem,
    deleteCollectionItem,
    remapCollectionId,
    // meta
    getMeta,
    setMeta,
    clearAll
  };
})();
