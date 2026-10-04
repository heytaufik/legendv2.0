import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJsonDocumentStore } from '../lib/json-document-store.js';

class FakePool {
  documents = new Map();

  async query(query, values = []) {
    const sql = query.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('CREATE TABLE')) return { rows: [] };
    if (sql.startsWith('SELECT document_key')) {
      return { rows: this.documents.has(values[0]) ? [{ document_key: values[0] }] : [] };
    }
    if (sql.startsWith('SELECT payload')) {
      const payload = this.documents.get(values[0]);
      return { rows: payload === undefined ? [] : [{ payload: structuredClone(payload) }] };
    }
    if (sql.startsWith('INSERT INTO app_documents') && sql.includes('ON CONFLICT (document_key) DO NOTHING')) {
      if (!this.documents.has(values[0])) this.documents.set(values[0], JSON.parse(values[1]));
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO app_documents')) {
      this.documents.set(values[0], JSON.parse(values[1]));
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

test('reads and atomically writes JSON documents locally when no database URL is configured', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'legend-document-store-'));
  const filePath = path.join(directory, 'nested', 'profiles.json');
  const store = createJsonDocumentStore({ documents: { profiles: filePath } });

  try {
    assert.equal(store.mode, 'local-json');
    assert.equal(await store.read('profiles'), null);
    const document = { '2026-10-05': { NIFTY: { close: 100 } } };
    await store.write('profiles', document);
    assert.deepEqual(await store.read('profiles'), document);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), document);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('migrates existing local documents once and then treats PostgreSQL as authoritative', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'legend-document-store-'));
  const filePath = path.join(directory, 'profiles.json');
  const legacyDocument = { legacy: true };
  await writeFile(filePath, JSON.stringify(legacyDocument), 'utf8');
  const pool = new FakePool();
  const store = createJsonDocumentStore({
    connectionString: 'postgres://test',
    documents: { profiles: filePath },
    pool
  });

  try {
    await store.initialize();
    assert.deepEqual(await store.read('profiles'), legacyDocument);
    const savedDocument = { current: true };
    await store.write('profiles', savedDocument);
    await writeFile(filePath, JSON.stringify({ stale: true }), 'utf8');
    assert.deepEqual(await store.read('profiles'), savedDocument);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not overwrite a document already present in PostgreSQL during migration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'legend-document-store-'));
  const filePath = path.join(directory, 'profiles.json');
  await writeFile(filePath, JSON.stringify({ legacy: true }), 'utf8');
  const pool = new FakePool();
  pool.documents.set('profiles', { database: true });
  const store = createJsonDocumentStore({
    connectionString: 'postgres://test',
    documents: { profiles: filePath },
    pool
  });

  try {
    await store.initialize();
    assert.deepEqual(await store.read('profiles'), { database: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
