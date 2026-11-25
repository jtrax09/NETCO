import { jsPDF } from 'jspdf';

export function exportVouchersPdf(
  vouchers: Array<{
    code?: string | null;
    codeMasked: string;
    packageName: string;
    priceTzs: number;
    durationMinutes: number;
    status: string;
  }>
) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('TRAX LINK — Hotspot Voucher Sheet', 40, 44);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated: ${new Date().toLocaleString()} · Maximum 1 Device Per Voucher`, 40, 62);

  let x = 40;
  let y = 84;
  const cardW = 248;
  const cardH = 84;
  const gap = 16;

  vouchers.forEach((v, idx) => {
    if (y + cardH > 790) {
      doc.addPage();
      y = 44;
    }
    doc.setDrawColor(200, 210, 224);
    doc.rect(x, y, cardW, cardH);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('TRAX LINK WiFi Access', x + 12, y + 18);

    doc.setFont('courier', 'bold');
    doc.setFontSize(13);
    doc.text(v.code || v.codeMasked, x + 12, y + 40);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`${v.packageName} · ${v.priceTzs.toLocaleString()} TZS`, x + 12, y + 58);
    doc.text(`Status: ${v.status} · 1 Device Limit`, x + 12, y + 72);

    if (idx % 2 === 0) {
      x = 40 + cardW + gap;
    } else {
      x = 40;
      y += cardH + 12;
    }
  });

  doc.save('traxlink-vouchers.pdf');
}

export function exportReportPdf(params: {
  title: string;
  subtitle: string;
  headers: string[];
  rows: string[][];
  filename: string;
}) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(`TRAX LINK — ${params.title}`, 40, 44);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`${params.subtitle} · Generated ${new Date().toLocaleString()}`, 40, 62);

  let y = 92;
  const colW = Math.floor(515 / Math.max(1, params.headers.length));

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  params.headers.forEach((h, i) => {
    doc.text(h.slice(0, 22), 40 + i * colW, y);
  });
  y += 8;
  doc.setDrawColor(180, 190, 205);
  doc.line(40, y, 555, y);
  y += 14;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  for (const row of params.rows) {
    if (y > 780) {
      doc.addPage();
      y = 48;
    }
    row.forEach((cell, i) => {
      doc.text(String(cell ?? '').slice(0, 24), 40 + i * colW, y);
    });
    y += 16;
  }

  doc.save(params.filename);
}
