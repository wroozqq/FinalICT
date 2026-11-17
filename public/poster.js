'use strict';
// Printable door sign for one QR code (staff only: the QR list and image need a staff session).
(async function () {
  const id = Number(new URLSearchParams(location.search).get('id'));
  const msg = document.getElementById('pMsg');
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  try {
    const res = await fetch('/api/admin/qr');
    if (!res.ok) throw new Error(res.status === 401 ? 'Sign in on the staff dashboard first.' : 'Could not load the QR code.');
    const code = (await res.json()).codes.find((c) => c.code_id === id);
    if (!code) throw new Error('This QR code no longer exists. Open the poster again from the dashboard.');
    const entrance = code.code_type === 'in';
    document.getElementById('pType').textContent = entrance ? 'ENTRANCE · Scan to check in' : 'EXIT · Scan to check out';
    document.getElementById('pGym').textContent = code.gym_name;
    const img = document.getElementById('pQr');
    img.src = `/api/admin/qr/${code.code_id}.svg`;
    img.alt = `${entrance ? 'Entrance' : 'Exit'} QR code for ${code.gym_name}`;
    document.title = `${code.gym_name} – ${entrance ? 'entrance' : 'exit'} QR poster`;
  } catch (e) {
    msg.textContent = e.message;
  }
}());
