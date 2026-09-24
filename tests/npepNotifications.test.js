import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateNotification} from '../domain/npep/notifications.js';
import {notificationProjection} from '../services/npepNotificationService.js';

test('N2 strict receipts preserve three independent stages and reject extra authority fields', () => {
  const event = {eventId: randomUUID(), publicationId: 'notice-1', revision: 1, stage: 'DISMISSED', occurredAt: new Date().toISOString()};
  const body = events => ({requestId: randomUUID(), events});
  for (const stage of ['RECEIVED', 'DISPLAYED', 'DISMISSED']) assert.equal(validateNotification('receiptRequest', body([{...event, stage}])), true);
  for (const invalid of [{...event, stage: 'READ'}, {...event, revision: 0}, {...event, occurredAt: 'yesterday'}, {...event, schoolId: 'other'}]) {
    assert.equal(validateNotification('receiptRequest', body([invalid])), false);
  }
  assert.equal(validateNotification('receiptRequest', body([])), false);
  assert.equal(validateNotification('receiptRequest', body(Array(101).fill(event))), false);
});

test('N2 notification projection keeps author popup choice and refuses oversized content', () => {
  const row = {id: 'notice-1', revision: 1, title: '通知', content: '正文', publishAt: new Date(), expiresAt: null,
    contentJson: {popupEnabled: false, privateField: 'not exposed'}, author: {name: '教师', email: 'private@example.invalid'}};
  for (const priority of ['MINOR', 'NORMAL', 'IMPORTANT', 'URGENT']) {
    const item = notificationProjection({...row, priority});
    assert.equal(validateNotification('item', item), true);
    assert.equal(item.popupEnabled, priority !== 'MINOR');
    assert.equal(item.source, '教师');
    assert.equal(JSON.stringify(item).includes('private'), false);
  }
  assert.equal(notificationProjection({...row, priority: 'MINOR', contentJson: {popupEnabled: true}}).popupEnabled, true);
  assert.throws(() => notificationProjection({...row, content: 'x'.repeat(8001)}), {code: 'SNAPSHOT_LIMIT_EXCEEDED'});
  assert.throws(() => notificationProjection({...row, title: 'x'.repeat(161)}), {code: 'SNAPSHOT_LIMIT_EXCEEDED'});
  assert.throws(() => notificationProjection({...row, content: '😀'.repeat(4001)}), {code: 'SNAPSHOT_LIMIT_EXCEEDED'});
  assert.throws(() => notificationProjection({...row, title: '😀'.repeat(81)}), {code: 'SNAPSHOT_LIMIT_EXCEEDED'});
  const unicode = notificationProjection({...row, content: '😀'.repeat(4000), author: {name: 'a' + '😀'.repeat(100)}});
  assert.equal(unicode.content.length, 8000);
  assert.ok(unicode.source.length <= 120 && unicode.source.isWellFormed());
});
