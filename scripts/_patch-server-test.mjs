// 一次性修补：把 server.test.mjs 的 invalid team 用例替换为契约 v3 行为
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'tests/server.test.mjs';
let source = readFileSync(path, 'utf8');
const start = source.indexOf("test('invalid team is reassigned");
if (start < 0) {
  console.log('block not found');
  process.exit(1);
}
const end = source.indexOf('\n});\n', start);
if (end < 0) {
  console.log('block end not found');
  process.exit(1);
}
const replacement = `test('invalid team is reassigned instead of allocating a broken room; leaving an ended match preserves results', async t => {
  const { server, url } = await setup(t); const c = await client(t, url);
  const session = await join(c, 'create');
  assert.equal(server.rooms.size, 1);
  const room = server.rooms.get(session.code);
  room.match.start();
  room.match.end('squad', 0);
  assert.equal(room.match.phase, 'ended');
  assert.equal(room.match.winnerTeam, 0);
  c.send({ type: 'leave' });
  await c.next(type('left'));
  assert.equal(room.match.phase, 'ended');
  assert.equal(room.match.winnerTeam, 0);
});`;
source = source.slice(0, start) + replacement + source.slice(end + '\n});'.length);
writeFileSync(path, source);
console.log('patched invalid-team test');

