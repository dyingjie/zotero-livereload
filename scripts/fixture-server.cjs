// Deterministic, different PDF content for the live-reader freshness regression.
const http = require('node:http');

function pdf(label) {
  const stream = `BT /F1 24 Tf 50 700 Td (Figure 1: ${label}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 6\n0000000000 65535 f \n`;
  document += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

let version = 'OLD';
const server = http.createServer((request, response) => {
  const route = new URL(request.url, 'http://127.0.0.1').pathname;
  if (route === '/advance') {
    version = 'NEW'; response.end('ok'); return;
  }
  if (route !== '/main.pdf') { response.writeHead(404).end(); return; }
  const bytes = pdf(version);
  response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length,
    // Intentionally keep timestamps and size unchanged: forced refresh must fetch bytes.
    'Last-Modified': 'Wed, 21 Oct 2026 00:00:00 GMT', 'Cache-Control': 'max-age=3600' });
  response.end(request.method === 'HEAD' ? undefined : bytes);
});
server.listen(18765, '127.0.0.1');
