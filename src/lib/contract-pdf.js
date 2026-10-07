'use strict';
/**
 * The signed agreement as a PDF: the document a customer keeps, files or
 * forwards, and the one produced if the agreement is ever disputed.
 *
 * Drawn with pdfkit rather than by printing the web page in a headless
 * browser. A browser is some sixty megabytes to ship to a serverless host
 * and slow to start there; this is plain JavaScript. The wording follows the
 * web agreement clause for clause, and it reads from the same frozen data —
 * the contract's own terms and prices, and the Lessee as confirmed at signing.
 */
const path = require('path');
const PDFDocument = require('pdfkit');
const { fuelLabel } = require('./contracts');

const INK = '#15161a';
const SOFT = '#5b5e66';
const LINE = '#d6d8de';
const M = 50; // page margin

/** pdfkit embeds JPEG and PNG only; anything else is described, not drawn. */
const drawable = (mime) => mime === 'image/jpeg' || mime === 'image/png';

function render(data) {
  const {
    rental, quote, policy, wording, money, shots = {}, consents = [], fingerprint, issuedAt
  } = data;
  const company = wording.company || {};
  const agreement = wording.agreement || {};
  const terms = wording.terms || [];

  const doc = new PDFDocument({
    size: 'A4', margin: M, bufferPages: true,
    info: {
      Title: `Car Rental Agreement ${rental.contract_no}`,
      Author: company.name || '',
      Subject: `Signed by ${rental.signed_name || rental.full_name}`,
      CreationDate: issuedAt ? new Date(issuedAt.replace(' ', 'T') + 'Z') : new Date()
    }
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const width = doc.page.width - M * 2;
  const room = (h) => { if (doc.y + h > doc.page.height - M - 20) doc.addPage(); };
  const section = (title) => {
    room(60);
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
      .text(title.toUpperCase(), { characterSpacing: 0.8 });
    const y = doc.y + 3;
    doc.moveTo(M, y).lineTo(M + width, y).lineWidth(0.6).strokeColor(LINE).stroke();
    doc.y = y + 6;
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  };
  const para = (text) => { doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(text, { align: 'left', lineGap: 1.5 }); };
  /** Two columns of label / value pairs. */
  const pairs = (left, right) => {
    room(16 * Math.max(left.length, right.length) + 4);
    const top = doc.y;
    const col = width / 2;
    const draw = (rows, x) => {
      let y = top;
      for (const [label, value] of rows) {
        doc.font('Helvetica').fontSize(9).fillColor(SOFT).text(label, x, y, { width: 95 });
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(String(value ?? '—') || '—', x + 100, y, { width: col - 110 });
        y = Math.max(doc.y, y + 14) + 2;
      }
      return y;
    };
    const end = Math.max(draw(left, M), draw(right, M + col));
    doc.x = M;
    doc.y = end;
  };
  /** A money table: label on the left, amount on the right. */
  const money2 = (rows, totalRow) => {
    for (const [label, amount] of rows) {
      room(18);
      const y = doc.y;
      doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(label, M, y, { width: width - 140 });
      doc.font('Courier').fontSize(9.5).text(amount, M + width - 140, y, { width: 140, align: 'right' });
      doc.y = Math.max(doc.y, y + 14);
    }
    if (totalRow) {
      const y = doc.y + 3;
      doc.moveTo(M, y).lineTo(M + width, y).lineWidth(1).strokeColor(INK).stroke();
      doc.font('Helvetica-Bold').fontSize(10.5).text(totalRow[0], M, y + 6, { width: width - 140 });
      doc.font('Courier-Bold').fontSize(10.5).text(totalRow[1], M + width - 140, y + 6, { width: 140, align: 'right' });
      doc.x = M;
      doc.y = y + 22;
    }
  };

  // ---- Header ----
  const logo = path.join(__dirname, '..', '..', 'public', 'img', 'logo-badge-ink.png');
  try { doc.image(logo, M, M - 4, { height: 40 }); } catch { /* the mark is decoration; its absence is not an error */ }
  doc.font('Helvetica-Bold').fontSize(17).fillColor(INK).text(company.name || '', M + 50, M + 2, { width: width / 2 });
  doc.font('Helvetica').fontSize(8.5).fillColor(SOFT);
  const contact = [company.address, [company.phone, company.email].filter(Boolean).join(' · '),
    [company.regNo ? `CR ${company.regNo}` : '', company.vatNo ? `VAT ${company.vatNo}` : ''].filter(Boolean).join(' · ')]
    .filter(Boolean);
  doc.text(contact.join('\n'), M + 50, doc.y + 2, { width: width / 2 });
  const headEnd = doc.y;

  doc.font('Helvetica').fontSize(8).fillColor(SOFT).text('CAR RENTAL AGREEMENT', M, M + 2, { width, align: 'right', characterSpacing: 1 });
  doc.font('Courier-Bold').fontSize(15).fillColor(INK).text(rental.contract_no, M, M + 14, { width, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(SOFT)
    .text(`Made on ${String(rental.created_at).slice(0, 10)}`, M, M + 33, { width, align: 'right' });

  doc.y = Math.max(headEnd, M + 50) + 8;
  doc.moveTo(M, doc.y).lineTo(M + width, doc.y).lineWidth(1.5).strokeColor(INK).stroke();
  doc.x = M;
  doc.y += 10;
  para(`This Car Rental Agreement ("Agreement") is made and entered into as of ${String(rental.created_at).slice(0, 10)}, `
    + `by and between ${company.name || 'the Lessor'} ("Lessor") and ${rental.full_name} ("Lessee").`);

  // ---- 1-3: vehicle, period, rate ----
  section('1. Vehicle information');
  pairs(
    [['Make', rental.make], ['Model', rental.model], ['Year', rental.year || '—']],
    [['Colour', rental.color || '—'], ['Plate number', rental.plate], ['VIN', rental.vin || '—']]
  );

  section('2. Rental period');
  pairs(
    [['Start', `${rental.start_date}${rental.start_time ? ' ' + rental.start_time : ''}`],
      ['End', `${rental.end_date}${rental.end_time ? ' ' + rental.end_time : ''}`]],
    [['Duration', `${quote.days} day${quote.days === 1 ? '' : 's'}`],
      ['Odometer out', `${Number(rental.pickup_odometer || 0).toLocaleString('en-US')} km`]]
  );

  section('3. Rental rate');
  para(`The rental rate shall be ${money(rental.daily_rate)} per day, plus any applicable taxes and fees.`);
  doc.moveDown(0.3);
  const rows = [[`${quote.days} day${quote.days === 1 ? '' : 's'} × ${money(rental.daily_rate)}`, money(quote.baseCharge)]];
  if (Number(rental.discount) > 0) rows.push(['Discount', `-${money(rental.discount)}`]);
  money2(rows, ['Agreement total', money(quote.total)]);

  // ---- 4-9: the clauses ----
  section('4. Security deposit');
  const balance = quote.balanceDue > 0
    ? `a further ${money(quote.balanceDue)} will then be due from the Lessee`
    : quote.balanceDue < 0
      ? `${money(-quote.balanceDue)} of the deposit will then be refunded to the Lessee`
      : 'the deposit exactly covers it';
  para(`The Lessee shall pay a refundable security deposit of ${money(rental.deposit)} before taking possession of the `
    + 'vehicle. It covers any damage to the vehicle during the rental period or other amounts due, and the balance is '
    + `refunded after inspection. Payable at handover: the deposit of ${money(rental.deposit)}. The agreement total is `
    + `settled on return, against the deposit: on the terms above, ${balance}, before any charges for late return, `
    + 'extra kilometres, fuel or damage.' + (company.bank ? ` Payment may be made to ${company.bank}.` : ''));

  section('5. Insurance and deductibles');
  para('The Lessee is responsible for any damage to the vehicle not covered by the insurance policy. The deductible '
    + `for any damage claim shall be ${rental.deductible ? money(rental.deductible) : 'as stated in the insurance policy'}.`);

  section('6. Condition of vehicle');
  para('The Lessor states that the vehicle is in good condition and free of any known mechanical issues, except as '
    + 'disclosed here. The Lessee agrees to return the vehicle in the same condition, ordinary wear and tear excepted.');
  doc.moveDown(0.3).font('Helvetica-Oblique').fontSize(9).fillColor(SOFT)
    .text(`Recorded at handover: ${rental.pickup_notes || 'No pre-existing damage recorded.'}`);

  section('7. Fuel policy');
  para(`The vehicle is provided at ${fuelLabel(rental.pickup_fuel)} and must be returned at the same level. If it is `
    + `not, a refuelling fee of ${money(policy.fuelChargePerEighth)} per 1/8 of a tank will be charged.`);

  section('8. Mileage limit');
  para(rental.km_allowance_per_day
    ? `The Lessee is allowed ${rental.km_allowance_per_day} kilometres per day `
      + `(${(rental.km_allowance_per_day * quote.days).toLocaleString('en-US')} km over this agreement). `
      + `Additional mileage is charged at ${money(rental.excess_km_rate)} per kilometre.`
    : 'Mileage is unlimited under this agreement.');

  section('9. Return of vehicle');
  para(`The vehicle shall be returned to ${rental.return_location || company.address || "the Lessor's place of business"} `
    + 'on or before the end date and time stated above. Late returns incur an additional fee of '
    + `${policy.lateDayMultiplier}× the daily rate per day, being ${money(rental.daily_rate * policy.lateDayMultiplier)} per day.`);

  section('10. Terms');
  terms.forEach((clause, i) => {
    room(24);
    doc.font('Helvetica').fontSize(8.8).fillColor(INK).text(`${i + 1}.  ${clause}`, { lineGap: 1, paragraphGap: 3 });
  });

  let n = 11;
  if (agreement.governingLaw) {
    section(`${n++}. Governing law`);
    para(`This Agreement shall be governed by the laws of ${agreement.governingLaw}.`);
  }

  section(`${n++}. Lessee details`);
  pairs(
    [['Name', rental.full_name], ['Mobile', rental.phone], ['Email', rental.email || '—'],
      ['ID / passport', rental.id_number || '—'], ['Address', rental.address || '—']],
    [['Licence', rental.license_number || '—'], ['Licence expiry', rental.license_expiry || '—'],
      ['Emergency contact', rental.emergency_name || '—'], ['Emergency number', rental.emergency_phone || '—'],
      ['Lessor phone', company.phone || '—']]
  );

  // ---- Licence photographs ----
  section(`${n++}. Driving licence`);
  const sides = [['front', 'Front'], ['back', 'Back']].filter(([k]) => shots[k]);
  if (!sides.length) {
    para('No copy of the driving licence is attached to this Agreement.');
  } else {
    para('The Lessee produced the driving licence below, which is reproduced as it was shown and forms part of this Agreement.');
    room(170);
    const top = doc.y + 6;
    const w = (width - 14) / 2;
    sides.forEach(([key, label], i) => {
      const x = M + i * (w + 14);
      const shot = shots[key];
      if (drawable(shot.mime)) {
        try { doc.image(shot.buffer, x, top, { fit: [w, 150], align: 'center', valign: 'center' }); } catch { /* unreadable image */ }
      } else {
        doc.font('Helvetica').fontSize(9).fillColor(SOFT).text(`${label}: image on file (${shot.mime})`, x, top + 60, { width: w, align: 'center' });
      }
      doc.rect(x, top, w, 150).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(SOFT)
        .text(`${label} · ${String(shot.capturedAt || '').slice(0, 16)} UTC · ${String(shot.digest || '').slice(0, 8).toUpperCase()}`, x, top + 154, { width: w });
    });
    doc.x = M;
    doc.y = top + 170;
  }

  // ---- Signatures ----
  section(`${n++}. Signatures`);
  para('IN WITNESS WHEREOF, the parties have executed this Agreement as of the date first written above.');
  room(110);
  const sigTop = doc.y + 10;
  const half = (width - 30) / 2;
  if (rental.signature_data) {
    const png = Buffer.from(String(rental.signature_data).split(',')[1] || '', 'base64');
    try { doc.image(png, M, sigTop, { fit: [half, 60], valign: 'bottom' }); } catch { /* a damaged signature image */ }
  }
  doc.moveTo(M, sigTop + 64).lineTo(M + half, sigTop + 64).lineWidth(0.8).strokeColor(INK).stroke();
  doc.moveTo(M + half + 30, sigTop + 64).lineTo(M + width, sigTop + 64).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`Lessee — ${rental.signed_name || rental.full_name}`, M, sigTop + 70, { width: half });
  doc.font('Helvetica').fontSize(8).fillColor(SOFT)
    .text(rental.handover_signed_at ? `Signed electronically ${rental.handover_signed_at} UTC` : 'Signature & date', M, doc.y + 1, { width: half });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
    .text(`Lessor — ${company.name || ''}${rental.issued_by ? ` (${rental.issued_by})` : ''}`, M + half + 30, sigTop + 70, { width: half });
  doc.font('Helvetica').fontSize(8).fillColor(SOFT).text('Issued electronically by the Lessor', M + half + 30, doc.y + 1, { width: half });
  doc.x = M;

  // ---- Signing record ----
  if (rental.signature_data) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text('Signing record');
    doc.font('Helvetica').fontSize(9).fillColor(SOFT)
      .text(`How agreement ${rental.contract_no} was signed electronically, from ${company.name || "the Lessor"}'s records.`);
    section('The signature');
    pairs(
      [['Signed by', rental.signed_name], ['Lessee', rental.full_name], ['Signed at', `${rental.handover_signed_at} UTC`]],
      [[rental.sent_to ? 'Link sent to' : 'Email given', rental.sent_to || rental.signed_email || '—'], ['Network address', rental.signed_ip || '—'],
        ['Access code', rental.sign_code_at ? `entered ${rental.sign_code_at} UTC` : 'not required']]
    );
    if (consents.length) {
      section('What the Lessee confirmed');
      consents.forEach((c, i) => {
        room(28);
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(`${i + 1}.  ${c.text}`, { lineGap: 1, paragraphGap: 4 });
      });
    }
    section('Fingerprint');
    para(`Document fingerprint (SHA-256 of the parties, vehicle, dates, charges, terms and licence copies): ${fingerprint || 'not recorded'}. `
      + 'If any of those change after signing, the fingerprint no longer matches.');
    doc.moveDown(0.6).font('Helvetica').fontSize(8.5).fillColor(SOFT)
      .text('A simple electronic signature supported by an audit trail. It is not a certificate-based or qualified '
        + 'electronic signature, and is not offered as one.');
  }

  // ---- Page footers ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // The footer sits in the bottom margin; with the margin in force, pdfkit
    // takes any text there as an overflow and starts a fresh page for it —
    // which turned three pages into nine, six of them blank but for a footer.
    doc.page.margins.bottom = 0;
    const y = doc.page.height - M + 14;
    doc.font('Helvetica').fontSize(7.5).fillColor(SOFT)
      .text(`${rental.contract_no} · ${company.name || ''}`, M, y, { width: width / 2, lineBreak: false })
      .text(`Page ${i + 1} of ${range.count}`, M + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });
  }

  doc.end();
  return done;
}

module.exports = { render };
