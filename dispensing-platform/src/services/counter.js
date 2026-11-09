import { tx } from '../db.js';
import { DomainError, notFound, conflict, forbidden } from '../domain/errors.js';

// Point of sale: one basket for released scripts and over-the-counter
// products, payment, refunds, pickup by code, end of day and an accounting
// export.
//
// Prices are GST-inclusive (NZ GST 15%), so GST = total × 3/23.
// Refunded OTC stock goes back on the shelf. Refunded prescription medicines
// do NOT: in pharmacy practice medicines that have left the pharmacy are
// destroyed, not resold.

const gstOf = (cents) => Math.round((cents * 3) / 23);

export function createCounter({ db, platform, adapters, config }) {
  const { moveStock, onHand, medicine, fulfilmentAction, getFulfilment, audit, one, all, run } = platform._internal;
  const staff = (user) => {
    if (!user || !['pharmacist', 'technician', 'admin'].includes(user.role)) throw forbidden('Counter staff only');
  };

  function getSale(id) {
    const sale = one('SELECT s.*, p.name AS patient_name FROM sales s LEFT JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', Number(id));
    if (!sale) throw notFound('Sale', id);
    sale.lines = all('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY id', sale.id);
    sale.total_cents = sale.lines.reduce((t, l) => t + l.unit_cents * l.quantity, 0);
    sale.gst_cents = gstOf(sale.total_cents);
    sale.has_controlled = sale.lines.some((l) => l.kind === 'rx' && l.medicine_id && medicine(l.medicine_id)?.controlled_class);
    return sale;
  }

  function openSale(user, { patientId } = {}) {
    staff(user);
    const r = run('INSERT INTO sales (patient_id, user_id) VALUES (?, ?)', patientId ?? null, user.id);
    return getSale(Number(r.lastInsertRowid));
  }

  function requireOpen(id) {
    const sale = getSale(id);
    if (sale.status !== 'open') throw conflict(`Sale is ${sale.status}`);
    return sale;
  }

  function addRxJob(sale, jobId) {
    const job = one(
      `SELECT j.*, i.medicine_id, p.patient_id, m.name, m.strength, m.patient_charge_cents, f.method
       FROM dispense_jobs j JOIN prescription_items i ON i.id = j.item_id JOIN prescriptions p ON p.id = i.prescription_id
       JOIN medicines m ON m.id = i.medicine_id LEFT JOIN fulfilments f ON f.id = j.fulfilment_id WHERE j.id = ?`,
      Number(jobId),
    );
    if (!job) throw notFound('Dispense job', jobId);
    if (job.state !== 'released') throw conflict(`Rx ${job.id} is ${job.state}; only released scripts can be sold`);
    if (job.method !== 'pickup') throw conflict(`Rx ${job.id} is set for ${job.method}, not counter pickup`);
    if (sale.patient_id && sale.patient_id !== job.patient_id) throw conflict('That script belongs to a different patient');
    const dup = one(
      "SELECT l.id FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE l.job_id = ? AND s.status IN ('open','paid') AND l.refunded = 0",
      job.id,
    );
    if (dup) throw conflict(`Rx ${job.id} is already in a basket`);
    if (!sale.patient_id) run('UPDATE sales SET patient_id = ? WHERE id = ?', job.patient_id, sale.id);
    run(
      "INSERT INTO sale_lines (sale_id, kind, job_id, medicine_id, description, quantity, unit_cents) VALUES (?, 'rx', ?, ?, ?, 1, ?)",
      sale.id, job.id, job.medicine_id, `Rx ${job.id}-${job.sequence} ${job.name} ${job.strength}`, job.patient_charge_cents,
    );
  }

  function addLine(saleId, user, line) {
    staff(user);
    return tx(db, () => {
      const sale = requireOpen(saleId);
      if (line.kind === 'rx') {
        addRxJob(sale, line.jobId);
      } else if (line.kind === 'otc') {
        const med = medicine(Number(line.medicineId));
        if (!med) throw notFound('Product', line.medicineId);
        if (!med.is_otc) throw conflict(`${med.name} is not an over-the-counter product`);
        const qty = Number(line.quantity ?? 1);
        if (!Number.isInteger(qty) || qty < 1) throw new DomainError('Quantity must be a positive whole number');
        if (onHand(med.id) < qty) throw conflict(`Only ${onHand(med.id)} ${med.name} in stock`);
        run(
          "INSERT INTO sale_lines (sale_id, kind, medicine_id, description, quantity, unit_cents) VALUES (?, 'otc', ?, ?, ?, ?)",
          sale.id, med.id, `${med.name} ${med.strength}`, qty, med.price_cents,
        );
      } else {
        throw new DomainError('Line kind must be "rx" or "otc"');
      }
      return getSale(sale.id);
    });
  }

  /** Scan a pickup code: adds every released script in that pickup order. */
  function addByPickupCode(saleId, user, code) {
    staff(user);
    const f = one("SELECT id FROM fulfilments WHERE pickup_code = ? AND method = 'pickup'", String(code).trim().toUpperCase());
    if (!f) throw notFound('Pickup code', code);
    const ful = getFulfilment(f.id);
    if (ful.status !== 'open') throw conflict(`This pickup is ${ful.status}`);
    if (!ful.ready) throw conflict('Not every item in this order is ready yet');
    return tx(db, () => {
      const sale = requireOpen(saleId);
      for (const j of ful.jobs) addRxJob(getSale(sale.id), j.id);
      return getSale(sale.id);
    });
  }

  function removeLine(saleId, lineId, user) {
    staff(user);
    requireOpen(saleId);
    run('DELETE FROM sale_lines WHERE id = ? AND sale_id = ?', Number(lineId), Number(saleId));
    return getSale(saleId);
  }

  async function pay(saleId, user, { method = 'card', proof } = {}) {
    staff(user);
    const sale = requireOpen(saleId);
    if (!sale.lines.length) throw conflict('Basket is empty');
    if (sale.has_controlled && !proof) throw new DomainError('Controlled drug in basket: record who collected it and the ID checked');
    for (const l of sale.lines.filter((x) => x.kind === 'otc')) {
      if (onHand(l.medicine_id) < l.quantity) throw conflict(`Not enough ${l.description} in stock`);
    }
    const charge = await adapters.payments.charge({ amountCents: sale.total_cents, method });

    const result = tx(db, () => {
      for (const l of sale.lines.filter((x) => x.kind === 'otc')) {
        moveStock(l.medicine_id, -l.quantity, { reason: `Sold (sale ${sale.id})`, saleId: sale.id, userId: user.id, kind: 'sold' });
      }
      run(
        "UPDATE sales SET status = 'paid', total_cents = ?, payment_method = ?, payment_ref = ?, paid_at = datetime('now') WHERE id = ?",
        sale.total_cents, method, charge.ref, sale.id,
      );
      audit.record({ userId: user.id, action: 'sale.paid', entity: 'sale', entityId: sale.id, data: { total: sale.total_cents, method, ref: charge.ref } });
      return getSale(sale.id);
    });

    // Hand over: complete each pickup order whose scripts are all in this sale.
    const jobIds = new Set(sale.lines.filter((l) => l.kind === 'rx').map((l) => l.job_id));
    const fulfilmentIds = new Set(sale.lines.filter((l) => l.kind === 'rx').map((l) => one('SELECT fulfilment_id FROM dispense_jobs WHERE id = ?', l.job_id).fulfilment_id));
    const notes = [];
    for (const fid of fulfilmentIds) {
      const f = getFulfilment(fid);
      if (f.status === 'open' && f.jobs.every((j) => jobIds.has(j.id) || j.state === 'completed')) {
        await fulfilmentAction(fid, 'complete', user, { proof: proof ?? `Paid at counter (sale ${sale.id})` });
      } else {
        notes.push(`Pickup order ${fid} has other items not in this sale and stays open`);
      }
    }
    return { ...result, notes };
  }

  async function refund(saleId, user, { lineIds, reason } = {}) {
    if (!user || !['pharmacist', 'admin'].includes(user.role)) throw forbidden('Only a pharmacist can authorise refunds');
    if (!reason) throw new DomainError('A refund reason is required');
    const sale = getSale(saleId);
    if (!['paid', 'partially_refunded'].includes(sale.status)) throw conflict(`Cannot refund a ${sale.status} sale`);
    const targets = sale.lines.filter((l) => !l.refunded && (!lineIds || lineIds.map(Number).includes(l.id)));
    if (!targets.length) throw conflict('Nothing left to refund');
    const amount = targets.reduce((t, l) => t + l.unit_cents * l.quantity, 0);
    const r = await adapters.payments.refund({ ref: sale.payment_ref, amountCents: amount });

    return tx(db, () => {
      for (const l of targets) {
        run('UPDATE sale_lines SET refunded = 1 WHERE id = ?', l.id);
        if (l.kind === 'otc') moveStock(l.medicine_id, l.quantity, { reason: `Refund restock (sale ${sale.id})`, saleId: sale.id, userId: user.id, kind: 'refund_restock' });
      }
      const remaining = one('SELECT COUNT(*) AS n FROM sale_lines WHERE sale_id = ? AND refunded = 0', sale.id).n;
      run(
        'UPDATE sales SET refunded_cents = refunded_cents + ?, status = ? WHERE id = ?',
        amount, remaining ? 'partially_refunded' : 'refunded', sale.id,
      );
      audit.record({ userId: user.id, action: 'sale.refunded', entity: 'sale', entityId: sale.id, data: { amount, reason, ref: r.ref, lines: targets.map((l) => l.id) } });
      return getSale(sale.id);
    });
  }

  function endOfDay(date = new Date().toISOString().slice(0, 10)) {
    const sales = all("SELECT * FROM sales WHERE status <> 'open' AND status <> 'void' AND date(paid_at) = ?", date);
    const lines = sales.length
      ? all(`SELECT * FROM sale_lines WHERE sale_id IN (${sales.map(() => '?').join(',')})`, ...sales.map((s) => s.id))
      : [];
    const sum = (arr) => arr.reduce((t, l) => t + l.unit_cents * l.quantity, 0);
    const byMethod = {};
    for (const s of sales) byMethod[s.payment_method] = (byMethod[s.payment_method] ?? 0) + s.total_cents - s.refunded_cents;
    const gross = sum(lines);
    const refunds = sum(lines.filter((l) => l.refunded));
    return {
      date,
      transactions: sales.length,
      grossCents: gross,
      refundsCents: refunds,
      netCents: gross - refunds,
      gstCents: gstOf(gross - refunds),
      rxCents: sum(lines.filter((l) => l.kind === 'rx' && !l.refunded)),
      otcCents: sum(lines.filter((l) => l.kind === 'otc' && !l.refunded)),
      byMethod,
    };
  }

  /**
   * Accounting export in the column layout of Xero's sales invoice CSV import
   * (one invoice per sale, GST-inclusive amounts). Refunded lines are exported
   * as negative lines so the day still reconciles.
   */
  function accountingCsv({ from, to } = {}) {
    const where = ["s.status IN ('paid','refunded','partially_refunded')"];
    const params = [];
    if (from) { where.push('date(s.paid_at) >= ?'); params.push(from); }
    if (to) { where.push('date(s.paid_at) <= ?'); params.push(to); }
    const rows = all(
      `SELECT s.id AS sale_id, s.paid_at, p.name AS patient, l.* FROM sale_lines l JOIN sales s ON s.id = l.sale_id
       LEFT JOIN patients p ON p.id = s.patient_id WHERE ${where.join(' AND ')} ORDER BY s.id, l.id`,
      ...params,
    );
    const header = '*ContactName,*InvoiceNumber,*InvoiceDate,*DueDate,*Description,*Quantity,*UnitAmount,*AccountCode,*TaxType';
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const out = [header];
    for (const r of rows) {
      const date = r.paid_at.slice(0, 10);
      const account = r.kind === 'rx' ? config.accounts?.rx ?? '200' : config.accounts?.otc ?? '201';
      const contact = r.kind === 'rx' ? 'Prescription sales' : 'Retail sales'; // no patient names in the ledger
      const base = [contact, `POS-${r.sale_id}`, date, date, r.description, r.quantity, (r.unit_cents / 100).toFixed(2), account, '15% GST on Income'];
      out.push(base.map(esc).join(','));
      if (r.refunded) out.push([contact, `POS-${r.sale_id}`, date, date, `REFUND ${r.description}`, -r.quantity, (r.unit_cents / 100).toFixed(2), account, '15% GST on Income'].map(esc).join(','));
    }
    return out.join('\n');
  }

  return {
    openSale,
    getSale,
    addLine,
    addByPickupCode,
    removeLine,
    pay,
    refund,
    endOfDay,
    accountingCsv,
    listSales: () => all("SELECT s.*, p.name AS patient_name FROM sales s LEFT JOIN patients p ON p.id = s.patient_id ORDER BY s.id DESC LIMIT 100"),
    otcProducts: () => all('SELECT m.*, COALESCE(s.on_hand, 0) AS on_hand FROM medicines m LEFT JOIN stock s ON s.medicine_id = m.id WHERE m.is_otc = 1 ORDER BY m.name'),
  };
}
