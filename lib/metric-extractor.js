'use strict';

// Keys use dot-notation matching the flattened FTDC output.
// These are the paths as they appear after flattenDocInOrder().
const K = {
  cacheBytes:       'serverStatus.wiredTiger.cache.bytes currently in the cache',
  cacheMax:         'serverStatus.wiredTiger.cache.maximum bytes configured',
  cacheDirty:       'serverStatus.wiredTiger.cache.tracked dirty leaf page bytes in the cache',
  appEvict:         'serverStatus.wiredTiger.cache.pages evicted by application threads',
  modEvict:         'serverStatus.wiredTiger.cache.modified pages evicted by application threads',
  wtReadOut:        'serverStatus.wiredTiger.concurrentTransactions.read.out',
  wtReadTotal:      'serverStatus.wiredTiger.concurrentTransactions.read.totalTickets',
  wtWriteOut:       'serverStatus.wiredTiger.concurrentTransactions.write.out',
  wtWriteTotal:     'serverStatus.wiredTiger.concurrentTransactions.write.totalTickets',
  checkpointMs:     'serverStatus.wiredTiger.transaction.transaction checkpoint total time (msecs)',
  insert:           'serverStatus.opcounters.insert',
  query:            'serverStatus.opcounters.query',
  update:           'serverStatus.opcounters.update',
  delete:           'serverStatus.opcounters.delete',
  command:          'serverStatus.opcounters.command',
  getmore:          'serverStatus.opcounters.getmore',
  connCurrent:      'serverStatus.connections.current',
  connAvailable:    'serverStatus.connections.available',
  queueReaders:     'serverStatus.globalLock.currentQueue.readers',
  queueWriters:     'serverStatus.globalLock.currentQueue.writers',
  memResident:      'serverStatus.mem.resident',
  memVirtual:       'serverStatus.mem.virtual',
  netBytesIn:       'serverStatus.network.bytesIn',
  netBytesOut:      'serverStatus.network.bytesOut',
  cpuUser:          'systemMetrics.cpu.user_ms',
  cpuSys:           'systemMetrics.cpu.system_ms',
  cpuIdle:          'systemMetrics.cpu.idle_ms',
  cpuIowait:        'systemMetrics.cpu.iowait_ms',
  // 7.0+ execution control
  execTarget:       'serverStatus.executionControl.targetThroughput',
  execAdmitted:     'serverStatus.executionControl.numTicketsAdmitted',
};

// Multiservice FTDC (mongos/shard, 8.0+) nests the classic paths under a
// service prefix: 'common.serverStatus...', 'shard.serverStatus...', etc.
// Resolve each K path against the actual keys present in the first frame.
function resolveKeys(sampleMetrics) {
  const actualKeys = Object.keys(sampleMetrics);
  const resolved = {};
  for (const [name, path] of Object.entries(K)) {
    if (path in sampleMetrics) {
      resolved[name] = path;
      continue;
    }
    const suffix = '.' + path;
    resolved[name] = actualKeys.find(k => k.endsWith(suffix)) ?? path;
  }
  return resolved;
}

function get(metrics, key) {
  return metrics[key] ?? 0;
}

function delta(cur, prev, key) {
  const d = get(cur, key) - get(prev, key);
  return d < 0 ? 0 : d; // counters never go backwards except on restart
}

function diskDelta(cur, prev, suffix) {
  // Aggregate across all disk devices
  let total = 0;
  for (const key of Object.keys(cur)) {
    if (key.includes('systemMetrics.disks.') && key.endsWith(suffix)) {
      const prevVal = prev[key] ?? 0;
      const d = cur[key] - prevVal;
      if (d > 0) total += d;
    }
  }
  return total;
}

function extractSignals(frames) {
  if (frames.length === 0) return frames;
  const R = resolveKeys(frames[0].metrics);
  let prevMetrics = null;
  for (let i = 0; i < frames.length; i++) {
    const m = frames[i].metrics;
    const p = prevMetrics ?? m; // prev = self for frame 0

    const cacheMax = get(m, R.cacheMax) || 1;
    const readTotal = get(m, R.wtReadTotal) || 128;
    const writeTotal = get(m, R.wtWriteTotal) || 128;
    const connTotal = get(m, R.connCurrent) + get(m, R.connAvailable);

    // CPU
    const cpuUserD   = Math.max(0, get(m, R.cpuUser)   - get(p, R.cpuUser));
    const cpuSysD    = Math.max(0, get(m, R.cpuSys)    - get(p, R.cpuSys));
    const cpuIdleD   = Math.max(0, get(m, R.cpuIdle)   - get(p, R.cpuIdle));
    const cpuIowaitD = Math.max(0, get(m, R.cpuIowait) - get(p, R.cpuIowait));
    const cpuTotal   = cpuUserD + cpuSysD + cpuIdleD + cpuIowaitD || 1;

    // Disk — Linux systemMetrics reports 512-byte sectors, not bytes
    const diskReadBytes  = diskDelta(m, p, '.read_bytes')  || diskDelta(m, p, '.read_sectors')  * 512;
    const diskWriteBytes = diskDelta(m, p, '.write_bytes') || diskDelta(m, p, '.write_sectors') * 512;

    // Checkpoint: spike when a checkpoint finishes (cumulative ms jumps)
    const checkpointDelta = Math.max(0, get(m, R.checkpointMs) - get(p, R.checkpointMs));

    const insertRate  = i > 0 ? delta(m, p, R.insert)  : 0;
    const queryRate   = i > 0 ? delta(m, p, R.query)   : 0;
    const updateRate  = i > 0 ? delta(m, p, R.update)  : 0;
    const deleteRate  = i > 0 ? delta(m, p, R.delete)  : 0;
    const commandRate = i > 0 ? delta(m, p, R.command) : 0;
    const getmoreRate = i > 0 ? delta(m, p, R.getmore) : 0;

    frames[i].signals = {
      cache_fill_pct:        get(m, R.cacheBytes) / cacheMax,
      dirty_pct:             get(m, R.cacheDirty) / cacheMax,
      app_eviction_rate:     i > 0 ? delta(m, p, R.appEvict) + delta(m, p, R.modEvict) : 0,
      total_eviction_rate:   i > 0 ? delta(m, p, R.appEvict) + delta(m, p, R.modEvict) : 0,
      read_ticket_util:      get(m, R.wtReadOut)  / readTotal,
      write_ticket_util:     get(m, R.wtWriteOut) / writeTotal,
      read_tickets_out:      get(m, R.wtReadOut),
      write_tickets_out:     get(m, R.wtWriteOut),
      read_tickets_total:    readTotal,
      write_tickets_total:   writeTotal,
      conn_util:             connTotal > 0 ? get(m, R.connCurrent) / connTotal : 0,
      conn_current:          get(m, R.connCurrent),
      conn_available:        get(m, R.connAvailable),
      insert_rate:           insertRate,
      query_rate:            queryRate,
      update_rate:           updateRate,
      delete_rate:           deleteRate,
      command_rate:          commandRate,
      getmore_rate:          getmoreRate,
      total_ops_rate:        insertRate + queryRate + updateRate + deleteRate + commandRate + getmoreRate,
      cpu_user_pct:          cpuUserD   / cpuTotal,
      cpu_sys_pct:           cpuSysD    / cpuTotal,
      cpu_iowait_pct:        cpuIowaitD / cpuTotal,
      cpu_idle_pct:          cpuIdleD   / cpuTotal,
      disk_read_mbps:        diskReadBytes  / 1e6,
      disk_write_mbps:       diskWriteBytes / 1e6,
      net_in_mbps:           i > 0 ? delta(m, p, R.netBytesIn)  / 1e6 : 0,
      net_out_mbps:          i > 0 ? delta(m, p, R.netBytesOut) / 1e6 : 0,
      queue_readers:         get(m, R.queueReaders),
      queue_writers:         get(m, R.queueWriters),
      queue_depth:           get(m, R.queueReaders) + get(m, R.queueWriters),
      mem_resident_mb:       get(m, R.memResident),
      mem_virtual_mb:        get(m, R.memVirtual),
      checkpoint_duration_ms: checkpointDelta,
      exec_target_throughput: get(m, R.execTarget),
      exec_admitted:          get(m, R.execAdmitted),
    };

    // Free raw metrics to save memory after signal extraction
    prevMetrics = m;
    frames[i].metrics = null;
  }
  return frames;
}

function computeSubsystemHealth(signals) {
  const s = signals;
  const maxTicket = Math.max(s.read_ticket_util, s.write_ticket_util);

  return {
    wtCache:     s.cache_fill_pct > 0.92 || s.app_eviction_rate > 100 ? 'RED'
               : s.cache_fill_pct > 0.80 || s.dirty_pct > 0.15        ? 'YELLOW' : 'GREEN',
    execControl: maxTicket > 0.95                                       ? 'RED'
               : maxTicket > 0.80                                       ? 'YELLOW' : 'GREEN',
    connections: s.conn_util > 0.95                                     ? 'RED'
               : s.conn_util > 0.85                                     ? 'YELLOW' : 'GREEN',
    diskIO:      s.disk_write_mbps > 500 || s.cpu_iowait_pct > 0.40    ? 'RED'
               : s.disk_write_mbps > 200                                ? 'YELLOW' : 'GREEN',
    cpu:         s.cpu_iowait_pct > 0.50                                ? 'RED'
               : s.cpu_iowait_pct > 0.25                                ? 'YELLOW' : 'GREEN',
    operations:  s.queue_depth > 30                                     ? 'RED'
               : s.queue_depth > 10                                     ? 'YELLOW' : 'GREEN',
    replication: 'GREEN', // populated by anomaly detector if lag data present
    network:     'GREEN',
    memory:      'GREEN',
  };
}

// Predicate for ftdc-parser's keep option: a real FTDC chunk carries ~6000+
// metrics per sample; only materialize the ones the signal extractor reads.
const K_PATHS = Object.values(K);
function isRelevantMetric(key) {
  if (key.includes('systemMetrics.disks.')) return true;
  for (const path of K_PATHS) {
    if (key === path || key.endsWith('.' + path)) return true;
  }
  return false;
}

module.exports = { extractSignals, computeSubsystemHealth, isRelevantMetric };
