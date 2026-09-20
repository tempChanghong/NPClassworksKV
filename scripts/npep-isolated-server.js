// Disposable local integration host. This is not a production deployment entry.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import https from 'node:https';

const database = new URL(process.env.DATABASE_URL || '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !/^\/npclassworks_test_npep(?:_[a-z0-9_]+)?$/.test(database.pathname)) {
  throw new Error('NPEP integration host requires an explicitly named local disposable database');
}
const directory = resolve('deploy/runtime/npep-n1');
await mkdir(directory, {recursive: true});
process.env.NPEP_ENABLED = 'true';
process.env.NPEP_DEPLOYMENT_FILE = join(directory, 'deployment.json');
process.env.JWT_SECRET = randomBytes(48).toString('base64url');
process.env.ACCESS_TOKEN_EXPIRES_IN = '8h';
// Prevent optional production telemetry inherited from a developer shell.
delete process.env.AXIOM_TOKEN;
delete process.env.AXIOM_DATASET;
const [{prisma}, {generateAccessToken}, {default: express}, {createNpepRouter}] = await Promise.all([
  import('../utils/prisma.js'), import('../utils/tokenManager.js'), import('express'), import('../routes/v2/npep.js'),
]);
let config;
try { config = JSON.parse(await readFile(process.env.NPEP_DEPLOYMENT_FILE, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  config = {enabled: true, serverInstanceId: randomUUID(), deploymentEpoch: randomUUID()};
  await writeFile(process.env.NPEP_DEPLOYMENT_FILE, JSON.stringify(config, null, 2));
}
const existingGate = await prisma.npepDeployment.findUnique({where: {id: 'current'}});
if (existingGate && (existingGate.deploymentEpoch !== config.deploymentEpoch || existingGate.serverInstanceId !== config.serverInstanceId)) {
  throw new Error('Restored database gate mismatch; explicit recovery required');
}
if (!existingGate) await prisma.npepDeployment.create({data: {id: 'current', serverInstanceId: config.serverInstanceId, deploymentEpoch: config.deploymentEpoch}});
const account = await prisma.account.upsert({where: {provider_providerId: {provider: 'npep-isolated', providerId: 'administrator'}},
  create: {provider: 'npep-isolated', providerId: 'administrator', name: 'NPEP隔离测试管理员'}, update: {}});
let school = await prisma.school.findUnique({where: {code: 'NPEP-ISOLATED'}});
if (!school) school = await prisma.school.create({data: {code: 'NPEP-ISOLATED', name: 'NPEP隔离测试学校'}});
await prisma.schoolMember.upsert({where: {schoolId_accountId: {schoolId: school.id, accountId: account.id}}, create: {schoolId: school.id, accountId: account.id, role: 'OWNER'}, update: {}});
const term = await prisma.academicTerm.upsert({where: {schoolId_academicYear_semester: {schoolId: school.id, academicYear: 2099, semester: 1}}, create: {schoolId: school.id, academicYear: 2099, semester: 1, name: '隔离测试学期', status: 'ACTIVE'}, update: {}});
let workspace = await prisma.workspace.findFirst({where: {termId: term.id, code: 'NPEP-1'}});
if (!workspace) workspace = await prisma.workspace.create({data: {termId: term.id, code: 'NPEP-1', name: '隔离一班', type: 'ADMIN_CLASS'}});
let binding = await prisma.classroomScreenBinding.findFirst({where: {schoolId: school.id, name: 'NPEP隔离大屏'}});
if (!binding) binding = await prisma.classroomScreenBinding.create({data: {schoolId: school.id, administrativeClassId: workspace.id, name: 'NPEP隔离大屏', tokenHash: randomBytes(32).toString('hex'), createdByAccountId: account.id}});
const sessionId = randomUUID();
await prisma.accountSession.create({data: {id: sessionId, accountId: account.id, refreshTokenHash: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 8 * 3600000)}});
const app = express();
app.use('/api/v2/npep', createNpepRouter());
const port = Number(process.env.NPEP_TEST_PORT || 34439);
const server = https.createServer({key: await readFile(join(directory, 'localhost.key')), cert: await readFile(join(directory, 'localhost.crt'))}, app);
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
await writeFile(join(directory, 'fixture.json'), JSON.stringify({origin: `https://localhost:${port}`, ...config,
  schoolId: school.id, schoolName: school.name, administrativeClassId: workspace.id, screenBindingId: binding.id,
  bindingRevision: binding.npepBindingRevision, adminToken: generateAccessToken(account, sessionId), adminSessionId: sessionId,
  certificateFile: join(directory, 'localhost.crt'), expiresAt: new Date(Date.now() + 8 * 3600000).toISOString()}, null, 2));
console.log(`NPEP isolated HTTPS listening on localhost:${port}; credentials are in ignored fixture.json`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { server.closeAllConnections(); server.close(); await prisma.$disconnect(); process.exit(0); });
