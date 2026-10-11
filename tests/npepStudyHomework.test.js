import test from 'node:test';
import assert from 'node:assert/strict';
import {readStudyHomework, homeworkChunk, HOMEWORK_MAX_BYTES} from '../services/npepStudyHomework.js';
import {hash} from '../domain/npep/wire.js';
import {validateStudyDevice} from '../domain/npep/studyDevice.js';

function fixture() {
  const sources = [{id: 'one', name: '行政一班'}, {id: 'walk1', name: '物理走班 A'}, {id: 'walk2', name: '物理走班 B'}];
  let rows = [{id: 'assignment', revision: 1, title: '练习册', content: '第 12 页\n🙂完成实验题', subject: {name: '物理'},
    targets: [{workspaceId: 'one'}, {workspaceId: 'walk1'}, {workspaceId: 'foreign'}]}];
  const calls = [];
  const repo = {homeworkSources: async (_tx, school, term, ids) => {
    assert.equal(school, 'school'); assert.equal(term, 'term'); calls.push(ids); return sources;
  }};
  const current = {version: 'a'.repeat(64), scope: {schoolId: 'school', termId: 'term', classId: 'one'},
    effective: {settings: {homework: {enabled: true, sourceMode: 'OwnClass', sourceClassIds: []}}}};
  const tx = {publication: {findMany: async query => {
    assert.equal(query.where.type, 'ASSIGNMENT'); assert.equal(query.where.status, 'PUBLISHED');
    assert.ok(query.where.publishAt.lte instanceof Date); assert.equal(query.where.boardDate.toISOString(), '2026-10-12T00:00:00.000Z');
    assert.deepEqual(query.where.targets.some.workspaceId.in, ['one', 'walk1', 'walk2']);
    assert.equal(Object.hasOwn(query.select, 'author'), false); return structuredClone(rows);
  }}, $queryRaw: async () => []};
  return {tx, repo, current, calls, setRows: next => rows = next};
}
test('today uses school calendar and existing source expansion; publication is deduplicated with matching source labels', async () => {
  const f = fixture(), result = await readStudyHomework(f.tx, f.current, '2026-10-12', f.repo);
  assert.equal(hash(result.bytes), result.snapshotId); const value = JSON.parse(result.bytes);
  assert.equal(validateStudyDevice('homeworkSnapshot', value), true); assert.equal(value.items.length, 1);
  assert.deepEqual(value.items[0].sources, [{id:'one',name:'行政一班'},{id:'walk1',name:'物理走班 A'}]);
  assert.equal(value.items[0].content, '第 12 页\n🙂完成实验题'); assert.deepEqual(f.calls, [['one']]);
  f.current.effective.settings.homework.sourceMode = 'SelectedClasses'; f.current.effective.settings.homework.sourceClassIds = ['two', 'three'];
  await readStudyHomework(f.tx, f.current, '2026-10-12', f.repo); assert.deepEqual(f.calls.at(-1), ['two','three']);
});
test('empty subjects and disabled homework are not placeholders with invented work', async () => {
  const f = fixture(); f.setRows([{id:'empty',revision:1,title:' ',content:'\n',subject:{name:'化学'},targets:[]}]);
  assert.deepEqual(JSON.parse((await readStudyHomework(f.tx,f.current,'2026-10-12',f.repo)).bytes).items, []);
  f.current.effective.settings.homework.enabled = false; await readStudyHomework(f.tx,f.current,'2026-10-12',f.repo);
  assert.equal(f.calls.length, 1);
});
test('bounded transport preserves complete multibyte text and rejects mixed revisions instead of truncation', async () => {
  const f = fixture(); const content = '🙂长作业\n'.repeat(10000);
  f.setRows([{id:'long',revision:2,title:'',content,subject:{name:'物理'},targets:[{workspaceId:'walk2'}]}]);
  const snapshot = await readStudyHomework(f.tx,f.current,'2026-10-12',f.repo), first = homeworkChunk(snapshot,0), chunks = [];
  for (let index=0; index<first.count; index++) {
    const chunk = homeworkChunk(snapshot,index,index ? first.snapshotId : null);
    assert.equal(validateStudyDevice('homeworkChunk',chunk),true); assert.ok(Buffer.byteLength(JSON.stringify(chunk))<24000);
    chunks.push(Buffer.from(chunk.data,'base64'));
  }
  assert.equal(JSON.parse(Buffer.concat(chunks)).items[0].content,content);
  assert.throws(()=>homeworkChunk(snapshot,1,'b'.repeat(64)),{code:'HOMEWORK_CHANGED'});
  assert.throws(()=>homeworkChunk(snapshot,first.count),{code:'INVALID_REQUEST'});
  f.setRows([{id:'huge',revision:1,title:'',content:'a'.repeat(HOMEWORK_MAX_BYTES),subject:{name:'物理'},targets:[{workspaceId:'one'}]}]);
  await assert.rejects(readStudyHomework(f.tx,f.current,'2026-10-12',f.repo),{code:'HOMEWORK_LIMIT_EXCEEDED'});
});
