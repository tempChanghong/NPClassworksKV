import {fail, UUID, displayText} from './wire.js';

export const overviewFilters = ['ALL', 'ATTENTION', 'ONLINE', 'INACTIVE'];
export function readOverviewQuery(query) {
  if (Object.keys(query).some(key => !['limit', 'cursor', 'filter', 'search'].includes(key))) fail(400, 'INVALID_REQUEST');
  const {cursor, filter = 'ALL', search = '', limit = '20'} = query;
  if (typeof limit !== 'string' || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 ||
      (cursor !== undefined && (typeof cursor !== 'string' || !UUID.test(cursor))) ||
      !overviewFilters.includes(filter) || typeof search !== 'string' || [...search].length > 100) fail(400, 'INVALID_REQUEST');
  return {limit: Number(limit), cursor, filter, search: search.trim()};
}

// One server timestamp for counters, filters and items. Only explicit public
// fields leave this read model; credential/session identifiers and hashes do not.
export function buildDeviceOverview(records, bindings, config, query, at = Date.now()) {
  const screens = new Map(bindings.map(binding => [binding.id, binding]));
  const summary = {total: records.length, active: 0, online: 0, offline: 0, unreported: 0, attention: 0, inactive: 0};
  const items = records.map(row => {
    const binding = screens.get(row.screenBindingId), workspace = binding?.administrativeClass;
    const bindingChanged = !binding?.isActive || binding.administrativeClassId !== row.administrativeClassId ||
      binding.npepBindingRevision !== row.bindingRevision || !workspace?.isActive || workspace.type !== 'ADMIN_CLASS' ||
      workspace.term?.status !== 'ACTIVE' || workspace.term.schoolId !== row.schoolId;
    let state = row.state;
    if (state === 'ACTIVE') {
      if (row.serverInstanceId !== config.serverInstanceId || row.deploymentEpoch !== config.deploymentEpoch || bindingChanged) state = 'INVALIDATED';
      else if (new Date(row.credentialExpiresAt).getTime() <= at) state = 'EXPIRED';
    }
    const seen = row.lastSeenAt ? new Date(row.lastSeenAt).getTime() : NaN;
    const connectivity = !Number.isFinite(seen) || seen > at ? 'UNKNOWN' : state === 'ACTIVE' && at - seen <= 60000 ? 'ONLINE' : 'OFFLINE';
    const issues = [];
    if (state === 'ACTIVE') {
      summary.active++;
      if (connectivity === 'UNKNOWN') { summary.unreported++; issues.push('UNREPORTED'); }
      else if (connectivity === 'OFFLINE') { summary.offline++; issues.push('OFFLINE'); }
      else {
        summary.online++;
        const status = row.status;
        if (!status || ['UNKNOWN', 'UNCONFIGURED'].includes(status.mode)) issues.push('MODE_NOT_READY');
        if (['INCOMPLETE', 'UNAVAILABLE'].includes(status?.modePhase)) issues.push('MODE_INCOMPLETE');
        if (!status || status.recording === 'UNKNOWN') issues.push('RECORDING_UNKNOWN');
        if (status?.mode === 'DAILY' && status.classIsland?.connection !== 'READY') issues.push('CLASSISLAND_NOT_CONNECTED');
        if (status?.mode === 'EXAM' && status.examAware?.connection !== 'READY') issues.push('EXAMAWARE_NOT_CONNECTED');
      }
      if (issues.length) summary.attention++;
    } else summary.inactive++;
    return {deviceId: row.id, schoolId: row.schoolId, administrativeClassId: row.administrativeClassId,
      screenBindingId: row.screenBindingId, bindingRevision: row.bindingRevision,
      deviceName: displayText(row.deviceName, 256), state, connectivity,
      credentialExpiresAt: new Date(row.credentialExpiresAt).toISOString(), lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null,
      // N1 status is validated on ingest; copy its allow-listed shape explicitly.
      status: row.status ? {appVersion: row.status.appVersion, mode: row.status.mode, modePhase: row.status.modePhase,
        modeRevision: row.status.modeRevision, automaticRecording: row.status.automaticRecording, recording: row.status.recording,
        classIsland: publicBridge(row.status.classIsland), examAware: publicBridge(row.status.examAware)} : null,
      screenBindingName: binding ? displayText(binding.name) : null,
      administrativeClassName: !bindingChanged && workspace ? displayText(workspace.name) : null,
      bindingChanged, issues};
  });
  const text = query.search.toLocaleLowerCase();
  const filtered = items.filter(item => (query.filter === 'ALL' || query.filter === 'ATTENTION' && item.issues.length > 0 ||
      query.filter === 'ONLINE' && item.state === 'ACTIVE' && item.connectivity === 'ONLINE' || query.filter === 'INACTIVE' && item.state !== 'ACTIVE') &&
    [item.deviceName, item.screenBindingName, item.administrativeClassName].some(value => value?.toLocaleLowerCase().includes(text)));
  const page = filtered.filter(item => !query.cursor || item.deviceId > query.cursor).slice(0, query.limit + 1);
  return {asOf: new Date(at).toISOString(), summary, matchedTotal: filtered.length,
    items: page.slice(0, query.limit), nextCursor: page.length > query.limit ? page[query.limit - 1].deviceId : null};
}

function publicBridge(value) { return value ? {connection: value.connection, bridgeVersion: value.bridgeVersion} : {connection: 'UNKNOWN', bridgeVersion: null}; }
