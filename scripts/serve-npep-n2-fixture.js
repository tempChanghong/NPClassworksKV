// Disposable local integration server. Never import or mount this in production.
import assert from 'node:assert/strict';
import {randomBytes, randomUUID, X509Certificate} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:https';

assert.equal(process.env.RUN_DATABASE_TESTS, 'true');
assert.equal(process.env.NODE_ENV, 'test');
const database = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname));
assert.match(database.pathname, /^\/npclassworks_test_n2_fixture_[a-z0-9_]+$/);
process.env.JWT_SECRET = randomBytes(48).toString('base64url');
process.env.JWT_ALG = 'HS256';
process.env.ACCESS_TOKEN_EXPIRES_IN = '24h';
const [directoryArg, portArg = '55481'] = process.argv.slice(2);
assert.ok(directoryArg, 'Pass a private output directory containing localhost-key.pem and localhost-cert.pem');
const directory = resolve(directoryArg), port = Number(portArg);
assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535);
const key = await readFile(resolve(directory, 'localhost-key.pem'));
const cert = await readFile(resolve(directory, 'localhost-cert.pem'));
const [{prisma}, {default: express}, {createNpepRouter}, {secretHash}, {generateAccessToken}] = await Promise.all([
  import('../utils/prisma.js'), import('express'), import('../routes/v2/npep.js'), import('../domain/npep/wire.js'), import('../utils/tokenManager.js'),
]);
assert.equal(await prisma.school.count(), 0, 'Fixture requires a fresh empty database');
assert.equal(await prisma.npepDevice.count(), 0);
assert.equal(await prisma.npepDeployment.count(), 0);
const identity = {serverInstanceId: randomUUID(), deploymentEpoch: randomUUID()};
const data = await prisma.$transaction(async tx => {
  await tx.npepDeployment.create({data: {id: 'current', ...identity}});
  const school = await tx.school.create({data: {code: `N2-${randomUUID()}`, name: 'N2隔离联调学校'}});
  const account = await tx.account.create({data: {provider: 'npep-fixture', providerId: randomUUID(), name: '联调教师'}});
  await tx.schoolMember.create({data: {schoolId: school.id, accountId: account.id, role: 'ADMIN'}});
  const session = await tx.accountSession.create({data: {id: randomUUID(), accountId: account.id,
    refreshTokenHash: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 86400000)}});
  const term = await tx.academicTerm.create({data: {schoolId: school.id, name: '隔离学期', academicYear: 2099, semester: 1, status: 'ACTIVE'}});
  const workspace = await tx.workspace.create({data: {termId: term.id, name: '隔离测试班', code: 'N2', type: 'ADMIN_CLASS'}});
  const binding = await tx.classroomScreenBinding.create({data: {schoolId: school.id, administrativeClassId: workspace.id,
    name: '隔离大屏', tokenHash: randomBytes(32).toString('hex'), createdByAccountId: account.id}});
  const credentialId = randomUUID(), deviceSecret = randomBytes(32).toString('base64url');
  const pairingBinding = await tx.classroomScreenBinding.create({data: {schoolId: school.id, administrativeClassId: workspace.id,
    name: '桌面配对隔离大屏', tokenHash: randomBytes(32).toString('hex'), createdByAccountId: account.id}});
  const device = await tx.npepDevice.create({data: {id: randomUUID(), installationId: randomUUID(), credentialId,
    secretHash: secretHash(deviceSecret), ...identity, schoolId: school.id, administrativeClassId: workspace.id,
    screenBindingId: binding.id, bindingRevision: binding.npepBindingRevision, deviceName: 'NPEduTools隔离联调',
    credentialExpiresAt: new Date(Date.now() + 86400000)}});
  return {school, account, session, workspace, binding, pairingBinding, device, credentialId, deviceSecret};
});
async function publish(input = {}) {
  const priority = input.priority || 'MINOR';
  assert.ok(['MINOR', 'NORMAL', 'IMPORTANT', 'URGENT'].includes(priority));
  assert.equal(typeof (input.content ?? '隔离联调正文'), 'string');
  assert.ok((input.content || '').length <= 8000 && (input.title || '').length <= 160);
  return prisma.publication.create({data: {type: 'NOTICE', status: 'PUBLISHED', priority,
    title: input.title || '隔离通知', content: input.content ?? '隔离联调正文',
    contentJson: {popupEnabled: priority !== 'MINOR' || input.popupEnabled === true},
    publishAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000),
    authorAccountId: data.account.id, targets: {create: {workspaceId: data.workspace.id}}}});
}
const notices = [];
for (let i = 0; i < 23; i++) notices.push(await publish({title: `隔离通知 ${i + 1}`, content: `第 ${i + 1} 条隔离正文`,
  priority: ['MINOR', 'NORMAL', 'IMPORTANT', 'URGENT'][i % 4], popupEnabled: false}));
const app = express(), controlSecret = randomBytes(32).toString('base64url');
app.use('/api/v2/npep', createNpepRouter({client: prisma, deployment: () => identity}));
app.use('/__fixture', (req, res, next) => req.get('Authorization') === `Bearer ${controlSecret}` ? next() : res.sendStatus(401));
app.use('/__fixture', express.json({limit: '32kb'}));
app.post('/__fixture/notices', async (req, res) => {
  try { res.status(201).json(await publish(req.body)); } catch { res.status(400).json({error: 'INVALID_FIXTURE_INPUT'}); }
});
app.get('/__fixture/receipts', async (_req, res) => {
  res.json(await prisma.npepNotificationReceipt.findMany({where: {device: {schoolId: data.school.id}}, orderBy: {receivedAt: 'asc'}}));
});
app.post('/__fixture/notices/:id/:action', async (req, res) => {
  const row = await prisma.publication.findFirst({where: {id: req.params.id, authorAccountId: data.account.id}});
  if (!row) return res.sendStatus(404);
  let patch;
  if (req.params.action === 'withdraw') patch = {status: 'WITHDRAWN'};
  else if (req.params.action === 'expire') patch = {expiresAt: new Date(Date.now() - 1000)};
  else if (req.params.action === 'revise' && typeof req.body.content === 'string' && req.body.content.length <= 8000) patch = {content: req.body.content};
  else return res.sendStatus(400);
  res.json(await prisma.publication.update({where: {id: row.id}, data: {...patch, revision: {increment: 1}}}));
});
const server = createServer({key, cert}, app);
await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
const output = resolve(directory, 'fixture.json');
await writeFile(output, JSON.stringify({baseUrl: `https://localhost:${port}`, ...identity,
  enabled: true, administrativeClassId: data.workspace.id,
  origin: `https://localhost:${port}`, certificateFile: resolve(directory, 'localhost-cert.pem'),
  adminToken: generateAccessToken(data.account, data.session.id), screenBindingId: data.pairingBinding.id,
  notifications: {expectedCount: 23, silentPublicationId: notices.find(n => n.priority === 'MINOR').id},
  certificateSha256: new X509Certificate(cert).fingerprint256,
  device: {...data.device, secretHash: undefined}, credentialId: data.credentialId, deviceSecret: data.deviceSecret,
  bearer: `npep1.${data.credentialId}.${data.deviceSecret}`, controlSecret,
  schoolId: data.school.id, workspaceId: data.workspace.id, noticeIds: notices.map(n => n.id),
  silentNoticeIds: notices.filter(n => n.priority === 'MINOR').map(n => n.id),
}, null, 2), {mode: 0o600});
console.log(`Isolated HTTPS fixture ready: ${output}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  server.closeAllConnections(); await new Promise(done => server.close(done)); await prisma.$disconnect(); process.exit(0);
});
