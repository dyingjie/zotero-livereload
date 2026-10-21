// Local development helper. Connects only to the isolated smoke-test debugger.
const net = require('node:net');
const fs = require('node:fs');
const socket = net.connect(6100, '127.0.0.1');
let buffer = Buffer.alloc(0);
const queue = [];
const waiters = [];
socket.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  while (true) {
    const colon = buffer.indexOf(':');
    if (colon < 0) return;
    const length = Number(buffer.subarray(0, colon).toString());
    if (buffer.length < colon + 1 + length) return;
    const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length));
    buffer = buffer.subarray(colon + 1 + length);
    const index = waiters.findIndex(w => w.match(packet));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(packet);
    else queue.push(packet);
  }
});
function receive(match = () => true) {
  const index = queue.findIndex(match);
  if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
  return new Promise(resolve => waiters.push({ match, resolve }));
}
function send(packet) {
  const json = JSON.stringify(packet);
  socket.write(Buffer.byteLength(json) + ':' + json);
}
async function request(packet) {
  send(packet);
  return receive(p => p.from === packet.to && !p.type);
}
const timeout = setTimeout(() => { console.error('Debugger timeout'); socket.destroy(); process.exitCode = 1; }, 25000);
(async () => {
  await receive(p => p.from === 'root');
  const root = await request({ to: 'root', type: 'getProcess', id: 0 });
  const target = root.processDescriptor
    ? await request({ to: root.processDescriptor.actor, type: 'getTarget' }) : root;
  const actor = target.form?.consoleActor || target.process?.consoleActor;
  if (!actor) throw new Error(JSON.stringify(target));
  const text = fs.readFileSync(process.argv[2], 'utf8');
  send({ to: actor, type: 'evaluateJSAsync', text, await: true });
  const result = await receive(p => p.type === 'evaluationResult');
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearTimeout(timeout); socket.destroy(); });
