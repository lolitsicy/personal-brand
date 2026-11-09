import { createHash } from 'node:crypto';

// Append-only, hash-chained audit log. Every write that matters to a
// regulator (dispensing decisions, checks, CD movements, claims) goes here.
// Tampering with or deleting a row breaks the chain, which verify() detects.

const GENESIS = '0'.repeat(64);

function hashRow({ at, user_id, action, entity, entity_id, data, prev_hash }) {
  return createHash('sha256')
    .update([at, user_id ?? '', action, entity, entity_id ?? '', data, prev_hash].join('|'))
    .digest('hex');
}

export function createAudit(db) {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const insert = db.prepare(
    `INSERT INTO audit_log (at, user_id, action, entity, entity_id, data, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    record({ userId = null, action, entity, entityId = null, data = {} }) {
      const row = {
        at: new Date().toISOString(),
        user_id: userId,
        action,
        entity,
        entity_id: entityId,
        data: JSON.stringify(data),
        prev_hash: last.get()?.hash ?? GENESIS,
      };
      row.hash = hashRow(row);
      insert.run(row.at, row.user_id, row.action, row.entity, row.entity_id, row.data, row.prev_hash, row.hash);
    },

    list({ entity, entityId, limit = 200 } = {}) {
      const where = [];
      const params = [];
      if (entity) { where.push('entity = ?'); params.push(entity); }
      if (entityId) { where.push('entity_id = ?'); params.push(Number(entityId)); }
      const sql = `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ?`;
      return db.prepare(sql).all(...params, Number(limit)).map((r) => ({ ...r, data: JSON.parse(r.data) }));
    },

    verify() {
      let prev = GENESIS;
      let count = 0;
      for (const row of db.prepare('SELECT * FROM audit_log ORDER BY id').iterate()) {
        if (row.prev_hash !== prev || hashRow(row) !== row.hash) {
          return { ok: false, brokenAt: row.id, checked: count };
        }
        prev = row.hash;
        count++;
      }
      return { ok: true, checked: count };
    },
  };
}
