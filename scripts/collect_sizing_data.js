// collect_sizing_data.js
// Comprehensive MongoDB Sizing Data Collection Script
// Compatible with MongoDB 4.4 - 8.0
//
// OPTIONAL: cluster-wide $indexStats union (scripts 04/05 inline).
// Default is FALSE so the script stays non-interactive. When TRUE the
// script auto-detects topology (sharded vs replica set vs standalone),
// prompts for a password via passwordPrompt(), opens a direct
// connection to every data-bearing member, and merges the result
// into report.indexUsageClusterWide. Requires DIRECT_CONNECT_USERNAME
// to have read access on every database on every node.
var COLLECT_CLUSTER_WIDE_INDEX_USAGE = false;
var DIRECT_CONNECT_USERNAME          = "sizingUser";
var DIRECT_CONNECT_AUTH_SOURCE       = "admin";
var DIRECT_CONNECT_TLS               = true; // Atlas requires TLS

// Windowed ops/sec sample length in seconds. 60s averages out
// sub-minute bursts; drop to 10-30s for steady workloads. Set to 0
// to skip the sample entirely and rely on lifetimeAverage only.
var OPS_SAMPLE_WINDOW_SECONDS = 60;

var report = {
    collectionTimestamp: new Date(),
    mongoVersion: db.version(),
    clusterInfo: {},
    dataMetrics: {},
    operationsMetrics: {},
    recommendations: []
};
print("\n" + "=".repeat(60));
print("MongoDB Atlas Sizing - Data Collection Script");
print("MongoDB Version: " + db.version());
print("=".repeat(60) + "\n");
// Per-node hardware / resource snapshot. Used both for the locally
// connected node and (when cluster-wide collection is enabled) for
// every data-bearing member discovered later.
function collectHostSnapshot(ss, hi) {
    var wt = (ss && ss.wiredTiger && ss.wiredTiger.cache) || {};
    var sys = (hi && hi.system) || {};
    var extra = (hi && hi.extra) || {};
    return {
        mongoVersion:  ss && ss.version,
        hostname:      sys.hostname || null,
        uptimeSeconds: ss && ss.uptime,
        storageEngine: ss && ss.storageEngine ? ss.storageEngine.name : "unknown",
        system: {
            cpuCores:         sys.numCores,
            numPhysicalCores: sys.numPhysicalCores,
            cpuArch:          sys.cpuArch,
            numaEnabled:      sys.numaEnabled,
            memSizeMB:        sys.memSizeMB,
            memLimitMB:       sys.memLimitMB
        },
        os: (hi && hi.os) || {},
        extra: {
            cpuFrequencyMHz: extra.cpuFrequencyMHz,
            kernelVersion:   extra.kernelVersion,
            libcVersion:     extra.libcVersion,
            pageSize:        extra.pageSize,
            maxOpenFiles:    extra.maxOpenFiles
        },
        memory: {
            residentMB: ss && ss.mem && ss.mem.resident,
            virtualMB:  ss && ss.mem && ss.mem.virtual
        },
        wiredTigerCache: {
            // NOTE: the WT field is "bytes currently in the cache" (with "the").
            // Earlier revisions of this script used "bytes currently in cache"
            // which silently returned undefined.
            maxBytesConfigured:      wt["maximum bytes configured"],
            bytesCurrentlyInCache:   wt["bytes currently in the cache"],
            trackedDirtyBytes:       wt["tracked dirty bytes in the cache"],
            // Cumulative counters (since mongod start). Used directly for a
            // lifetime hit ratio and sampled in the windowed block below for
            // a more recent ratio.
            pagesRequestedFromCache: wt["pages requested from the cache"],
            pagesReadIntoCache:      wt["pages read into cache"],
            pagesWrittenFromCache:   wt["pages written from cache"],
            unmodifiedPagesEvicted:  wt["unmodified pages evicted"],
            modifiedPagesEvicted:    wt["modified pages evicted"]
        },
        connections: (ss && ss.connections) || {},
        network: {
            bytesIn:     ss && ss.network && ss.network.bytesIn,
            bytesOut:    ss && ss.network && ss.network.bytesOut,
            numRequests: ss && ss.network && ss.network.numRequests
        }
    };
}

// Cluster Information (locally connected node)
try {
    var serverStatus = db.serverStatus();
    var hostInfo     = db.hostInfo();
    var localSnap    = collectHostSnapshot(serverStatus, hostInfo);
    // Top-level fields kept for backward compatibility with the summary
    // block and any downstream tooling that parsed the previous shape.
    report.clusterInfo = {
        mongoVersion:  localSnap.mongoVersion,
        hostname:      localSnap.hostname,
        cpuCores:      localSnap.system.cpuCores,
        memSizeMB:     localSnap.system.memSizeMB,
        storageEngine: localSnap.storageEngine,
        localSnapshot: localSnap,
        nodes: [],
        diskInfo: {
            note: "Disk size, free space, and IOPS are not exposed by mongosh. " +
                  "For Atlas, pull from the Atlas API (processMeasurements: " +
                  "DISK_PARTITION_SPACE_FREE, DISK_PARTITION_IOPS_*). " +
                  "For self-hosted, record manually from df/lsblk on the dbPath volume."
        }
    };
    print("✓ Cluster info collected (local node snapshot: cpu / mem / WT cache / connections / network / uptime)");
} catch (e) {
    print("✗ Error collecting cluster info: " + e.message);
}

// Data Metrics
var dataMetrics = {
    totalDataSizeGB: 0,
    totalDocuments: 0,
    totalRawSizeKB: 0,
    totalCompressedSizeKB: 0,
    totalIndexCount: 0,
    totalIndexSizeMB: 0,
    unusedIndexCount: 0,
    unusedIndexSizeMB: 0,
    maxSecondaryIndexes: 0,
    skippedCollections: [],
    collections: []
};

db.adminCommand({listDatabases: 1}).databases.forEach(function(database) {
    if (database.name !== "admin" && database.name !== "local" && database.name !== "config") {
        var currentDb = db.getSiblingDB(database.name);
        currentDb.getCollectionNames().forEach(function(collName) {
            try {
                var stats = currentDb[collName].stats();
                // Coerce numeric fields via Number() — collStats returns
                // them as BSON Long for large/system.buckets.* collections,
                // which fails a typeof === "number" check.
                var hasCount   = stats.count != null && !isNaN(Number(stats.count));
                var hasSize    = stats.size != null && Number(stats.size) > 0;
                var hasStorage = stats.storageSize != null && Number(stats.storageSize) > 0;
                var isBucketColl = collName.indexOf("system.buckets.") === 0;
                // Skip when there is nothing measurable. TS logical
                // namespaces on 6.0+/8.0 return no count/size/storage at
                // all (just a `timeseries` sub-object); their real data
                // lives on system.buckets.<coll> and is processed below.
                // Bucket collections themselves may lack `count` on 8.0
                // but still have size/storage — accept those.
                if (!hasCount && !hasSize && !hasStorage) {
                    var bucketHint = isBucketColl
                        ? collName
                        : "system.buckets." + collName;
                    dataMetrics.skippedCollections.push({
                        ns: database.name + "." + collName,
                        reason: stats.timeseries
                                ? "time-series logical namespace (storage counted via " + bucketHint + ")"
                                : "no numeric count/size (likely a view)"
                    });
                    return;
                }
                // Atlas 8.0 quirk: stats() on a logical time-series
                // namespace now returns the same count/size/storageSize
                // as its underlying system.buckets.<coll>. Including
                // both would double-count storage and indexes. The
                // bucket collection is the source of truth on disk and
                // is processed separately in this loop, so skip the
                // logical entry here.
                if (stats.timeseries && !isBucketColl) {
                    dataMetrics.skippedCollections.push({
                        ns: database.name + "." + collName,
                        reason: "time-series logical namespace (storage counted via system.buckets." + collName + " to avoid double-counting on Atlas 8.0)"
                    });
                    return;
                }
                var indexes = currentDb[collName].getIndexes();

                // Per-index usage from $indexStats (per-node, since last mongod start)
                var usageByName = {};
                try {
                    currentDb[collName].aggregate([{ $indexStats: {} }]).forEach(function(u) {
                        usageByName[u.name] = {
                            ops: u.accesses.ops.toString(),
                            since: u.accesses.since,
                            host: u.host
                        };
                    });
                } catch (ue) {
                    // $indexStats not supported (e.g. views) or insufficient privilege
                }

                // Per-index detail (name, key, size, usage)
                var indexSizes = stats.indexSizes || {};
                var unusedInColl = 0;
                var unusedSizeMBInColl = 0;
                var indexDetails = indexes.map(function(idx) {
                    var sizeBytes = indexSizes[idx.name] || 0;
                    var usage = usageByName[idx.name] || null;
                    var opsNum = usage ? Number(usage.ops) : null;
                    if (usage && opsNum === 0 && idx.name !== "_id_") {
                        unusedInColl++;
                        unusedSizeMBInColl += sizeBytes / 1024 / 1024;
                    }
                    return {
                        name: idx.name,
                        key: idx.key,
                        sizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
                        usage: usage ? {
                            ops: usage.ops,
                            since: usage.since,
                            host: usage.host,
                            unused: opsNum === 0
                        } : null
                    };
                });

                // collStats numeric fields may be BSON Long; coerce
                // before any `+` to avoid string concatenation. For
                // system.buckets.* on 8.0, `count` may be absent — fall
                // back to timeseries.bucketCount so the entry still has
                // a meaningful docs value (bucket count, not measurement
                // count; flagged via docsMeaning below).
                var sCount      = hasCount
                                  ? Number(stats.count)
                                  : (stats.timeseries && stats.timeseries.bucketCount != null
                                      ? Number(stats.timeseries.bucketCount)
                                      : 0);
                var sSize       = Number(stats.size) || 0;
                var sStorage    = Number(stats.storageSize) || 0;
                var sNindexes   = Number(stats.nindexes) || 0;
                var sTotalIdx   = Number(stats.totalIndexSize) || 0;
                var sAvgObjSize = (sCount > 0 && sSize > 0)
                                  ? (sSize / sCount)
                                  : Number(stats.avgObjSize) || 0;

                dataMetrics.totalDocuments += sCount;
                dataMetrics.totalRawSizeKB += (sSize / 1024);
                dataMetrics.totalCompressedSizeKB += (sStorage / 1024);
                dataMetrics.totalIndexCount += sNindexes;
                dataMetrics.totalIndexSizeMB += (sTotalIdx / 1024 / 1024);
                dataMetrics.unusedIndexCount += unusedInColl;
                dataMetrics.unusedIndexSizeMB += unusedSizeMBInColl;
                dataMetrics.maxSecondaryIndexes = Math.max(dataMetrics.maxSecondaryIndexes, sNindexes - 1);

                var collEntry = {
                    db: database.name,
                    collection: collName,
                    docs: sCount,
                    avgDocSizeKB: (sAvgObjSize / 1024).toFixed(2),
                    indexCount: sNindexes,
                    secondaryIndexes: sNindexes - 1,
                    unusedSecondaryIndexCount: unusedInColl,
                    unusedSecondaryIndexSizeMB: unusedSizeMBInColl.toFixed(2),
                    totalIndexSizeMB: (sTotalIdx / 1024 / 1024).toFixed(2),
                    indexes: indexDetails
                };
                if (stats.timeseries) {
                    // Only include fields actually present — Atlas 8.0
                    // omits numBucketInserts/Updates/numMeasurementsCommitted
                    // from system.buckets.* stats.
                    var tsOut = {};
                    var tsFields = ["bucketsNs", "bucketCount",
                                    "numBucketInserts", "numBucketUpdates",
                                    "numMeasurementsCommitted"];
                    tsFields.forEach(function(k) {
                        if (stats.timeseries[k] !== undefined) {
                            tsOut[k] = stats.timeseries[k];
                        }
                    });
                    collEntry.timeseries = tsOut;
                }
                // Tag bucket collections so the link to the parent TS
                // namespace is explicit and `docs` is not misread as
                // measurement count (it is bucket count).
                if (collName.indexOf("system.buckets.") === 0) {
                    collEntry.isTimeseriesBucketStorage = true;
                    collEntry.parentTimeseriesNs = database.name + "." +
                        collName.substring("system.buckets.".length);
                    collEntry.docsMeaning = "bucket count (not measurement count)";
                }
                dataMetrics.collections.push(collEntry);
            } catch (e) {
                // Record the failure so the report does not silently
                // drop collections. On Atlas 8.0, `db.<tsColl>.stats()`
                // on a logical time-series namespace throws because the
                // alias resolves to system.buckets.* (already processed
                // separately).
                var msg = (e && e.message) ? e.message : String(e);
                var isLikelyTsLogicalNs = msg.indexOf("not found") !== -1 ||
                                          msg.indexOf("CollectionUUIDMismatch") !== -1 ||
                                          msg.indexOf("time-series") !== -1;
                dataMetrics.skippedCollections.push({
                    ns: database.name + "." + collName,
                    reason: isLikelyTsLogicalNs
                            ? "stats() failed (likely time-series logical namespace; storage counted via system.buckets." + collName + ")"
                            : "stats() failed: " + msg
                });
            }
        });
    }
});

dataMetrics.totalDataSizeGB = (dataMetrics.totalRawSizeKB / 1024 / 1024).toFixed(2);
dataMetrics.avgDocSizeKB = dataMetrics.totalDocuments > 0 ?
    (dataMetrics.totalRawSizeKB / dataMetrics.totalDocuments).toFixed(2) : 0;
dataMetrics.compressionPct = dataMetrics.totalRawSizeKB > 0 ?
    ((1 - (dataMetrics.totalCompressedSizeKB / dataMetrics.totalRawSizeKB)) * 100).toFixed(2) : 0;
dataMetrics.totalIndexSizeMB = dataMetrics.totalIndexSizeMB.toFixed(2);
dataMetrics.unusedIndexSizeMB = dataMetrics.unusedIndexSizeMB.toFixed(2);

report.dataMetrics = dataMetrics;
print("✓ Data metrics collected ($indexStats: per-node, resets on restart/stepdown)");

// Operations Metrics
// opcounters values are BSON Long; the `+` operator on Long invokes
// Symbol.toPrimitive("default") which returns toString(), producing
// string concatenation instead of numeric addition. Force Number()
// on every counter before any arithmetic.
function opNum(v) { return v == null ? 0 : Number(v); }

// Helper: extract WT cache counter snapshot from a serverStatus result.
// All fields are cumulative BSON Long values since mongod start.
function wtCacheSnap(ss) {
    var c = (ss && ss.wiredTiger && ss.wiredTiger.cache) || {};
    return {
        bytesCurrentlyInCache:   opNum(c["bytes currently in the cache"]),
        trackedDirtyBytes:       opNum(c["tracked dirty bytes in the cache"]),
        pagesRequestedFromCache: opNum(c["pages requested from the cache"]),
        pagesReadIntoCache:      opNum(c["pages read into cache"]),
        pagesWrittenFromCache:   opNum(c["pages written from cache"]),
        unmodifiedPagesEvicted:  opNum(c["unmodified pages evicted"]),
        modifiedPagesEvicted:    opNum(c["modified pages evicted"])
    };
}

// Helper: per-namespace usage counters via db.adminCommand({top: 1}).
// Returns a map: ns -> { reads, writes, commands, totalOps } where
// reads = queries + getmore and writes = insert + update + remove.
// Only available on mongod (not mongos); returns null on sharded.
function topSnapshot() {
    try {
        var res = db.adminCommand({ top: 1 });
        if (!res || !res.totals) return null;
        var out = {};
        Object.keys(res.totals).forEach(function(ns) {
            var t = res.totals[ns];
            if (!t || typeof t !== "object") return;
            var reads    = opNum(t.queries && t.queries.count) + opNum(t.getmore && t.getmore.count);
            var writes   = opNum(t.insert && t.insert.count)
                         + opNum(t.update && t.update.count)
                         + opNum(t.remove && t.remove.count);
            var commands = opNum(t.commands && t.commands.count);
            out[ns] = {
                reads:    reads,
                writes:   writes,
                commands: commands,
                totalOps: reads + writes + commands
            };
        });
        return out;
    } catch (e) {
        return null;
    }
}

// Lifetime average (no wait): cumulative opcounters / uptime.
// Useful as a sanity floor; usually well below true peak because it
// is diluted by idle hours, restarts, and background activity.
var ssLifetime  = db.serverStatus();
var lifeOc      = ssLifetime.opcounters;
var lifeUptime  = opNum(ssLifetime.uptime);
var lifeReads   = opNum(lifeOc.query)  + opNum(lifeOc.getmore);
var lifeWrites  = opNum(lifeOc.insert) + opNum(lifeOc.update) + opNum(lifeOc.delete);
var lifeWt      = wtCacheSnap(ssLifetime);
var lifeHitPct  = lifeWt.pagesRequestedFromCache > 0
    ? (100 * (1 - lifeWt.pagesReadIntoCache / lifeWt.pagesRequestedFromCache))
    : null;
report.operationsMetrics = {
    lifetimeAverage: {
        uptimeSeconds:     lifeUptime,
        readOpsPerSecond:  lifeUptime > 0 ? Math.round(lifeReads  / lifeUptime) : 0,
        writeOpsPerSecond: lifeUptime > 0 ? Math.round(lifeWrites / lifeUptime) : 0,
        cacheHitRatioPct:  lifeHitPct != null ? Number(lifeHitPct.toFixed(2)) : null,
        warning: "Average since process start; includes idle hours, restarts, migrations. Do NOT use for peak sizing."
    },
    atlasApiNote: "For Atlas clusters, the canonical peak input is the Atlas Metrics API: " +
                  "processMeasurements?granularity=PT1M&metrics=OPCOUNTER_QUERY,OPCOUNTER_INSERT,OPCOUNTER_UPDATE,OPCOUNTER_DELETE,OPCOUNTER_GETMORE " +
                  "over a 7-day window, then take MAX()."
};

if (OPS_SAMPLE_WINDOW_SECONDS > 0) {
    print("\nMeasuring operations (" + OPS_SAMPLE_WINDOW_SECONDS + " second sample)...");
    var ssBefore   = db.serverStatus();
    var before     = ssBefore.opcounters;
    var wtBefore   = wtCacheSnap(ssBefore);
    var topBefore  = topSnapshot(); // null on mongos
    var beforeTime = new Date();
    sleep(OPS_SAMPLE_WINDOW_SECONDS * 1000);
    var ssAfter    = db.serverStatus();
    var after      = ssAfter.opcounters;
    var wtAfter    = wtCacheSnap(ssAfter);
    var topAfter   = topSnapshot();
    var afterTime  = new Date();
    var elapsed    = (afterTime - beforeTime) / 1000; // measured, not assumed

    var dReads  = (opNum(after.query)  - opNum(before.query))
                + (opNum(after.getmore) - opNum(before.getmore));
    var dWrites = (opNum(after.insert) - opNum(before.insert))
                + (opNum(after.update) - opNum(before.update))
                + (opNum(after.delete) - opNum(before.delete));

    // Cache pressure deltas. Hit ratio < ~95% on sustained workload is the
    // primary signal that the WT cache (and therefore the tier) is undersized.
    var dPagesReq    = wtAfter.pagesRequestedFromCache - wtBefore.pagesRequestedFromCache;
    var dPagesRead   = wtAfter.pagesReadIntoCache      - wtBefore.pagesReadIntoCache;
    var dPagesWrit   = wtAfter.pagesWrittenFromCache   - wtBefore.pagesWrittenFromCache;
    var dEvictUnmod  = wtAfter.unmodifiedPagesEvicted  - wtBefore.unmodifiedPagesEvicted;
    var dEvictMod    = wtAfter.modifiedPagesEvicted    - wtBefore.modifiedPagesEvicted;
    var windowHitPct = dPagesReq > 0 ? (100 * (1 - dPagesRead / dPagesReq)) : null;

    // Per-namespace breakdown via top() deltas. Splits into user vs
    // system namespaces so the report can reconcile per-collection ops
    // against opcounters totals (oplog/session/transaction writes on
    // local.*/admin.*/config.* often dominate write counts).
    var byNamespace = null;
    var byNamespaceNote = null;
    var systemNamespaceTotals = null;
    if (topBefore && topAfter) {
        var userRows = [];
        var sysR = 0, sysW = 0, sysC = 0;
        Object.keys(topAfter).forEach(function(ns) {
            var a = topAfter[ns];
            var b = topBefore[ns] || { reads: 0, writes: 0, commands: 0 };
            var dR = a.reads    - b.reads;
            var dW = a.writes   - b.writes;
            var dC = a.commands - b.commands;
            if (dR + dW + dC <= 0) return;
            var isSystem = ns.indexOf("admin.") === 0 || ns.indexOf("config.") === 0 ||
                           ns.indexOf("local.") === 0 || ns.indexOf("$cmd") !== -1;
            if (isSystem) {
                sysR += dR; sysW += dW; sysC += dC;
                return;
            }
            userRows.push({
                ns:               ns,
                readOpsPerSec:    +(dR / elapsed).toFixed(2),
                writeOpsPerSec:   +(dW / elapsed).toFixed(2),
                commandOpsPerSec: +(dC / elapsed).toFixed(2),
                totalOpsPerSec:   +((dR + dW + dC) / elapsed).toFixed(2),
                _rawTotal:        dR + dW + dC
            });
        });
        // Sort by raw delta — preserves ordering for sub-1 ops/sec rows.
        userRows.sort(function(x, y) { return y._rawTotal - x._rawTotal; });
        userRows.forEach(function(r) { delete r._rawTotal; });
        byNamespace = userRows;
        if (sysR + sysW + sysC > 0) {
            systemNamespaceTotals = {
                readOpsPerSec:    +(sysR / elapsed).toFixed(2),
                writeOpsPerSec:   +(sysW / elapsed).toFixed(2),
                commandOpsPerSec: +(sysC / elapsed).toFixed(2),
                note: "Aggregated ops/sec on system namespaces (admin.*, config.*, local.* — oplog, sessions, transactions). Explains any gap between opcounters totals and per-user-namespace sums."
            };
        }
    } else {
        byNamespaceNote = "top() not available (likely connected via mongos; run against each shard's primary for per-namespace breakdown).";
    }

    // Reconciliation between opcounters totals and per-namespace top()
    // sums. top() under-counts the following write categories vs
    // opcounters: bulkWrite/insertMany (recorded as commands), TS
    // inserts (recorded as commands on system.buckets.*), findAndModify
    // (recorded as commands), and any writer that issues commands
    // bypassing the per-collection latch (Atlas internal maintenance).
    // A large unaccounted gap usually means bulk/TS/internal writers,
    // not under-instrumentation in the script.
    var nsWriteSum = 0, nsReadSum = 0;
    if (byNamespace) {
        byNamespace.forEach(function(r) {
            nsWriteSum += r.writeOpsPerSec;
            nsReadSum  += r.readOpsPerSec;
        });
    }
    var sysWrites = systemNamespaceTotals ? systemNamespaceTotals.writeOpsPerSec : 0;
    var sysReads  = systemNamespaceTotals ? systemNamespaceTotals.readOpsPerSec  : 0;
    var totalWritesRate = dWrites / elapsed;
    var totalReadsRate  = dReads  / elapsed;
    var writeAccounted  = nsWriteSum + sysWrites;
    var readAccounted   = nsReadSum  + sysReads;

    report.operationsMetrics.windowedSample = {
        windowSecondsRequested: OPS_SAMPLE_WINDOW_SECONDS,
        windowSecondsMeasured:  elapsed,
        readOpsPerSecond:  Math.round(dReads  / elapsed),
        writeOpsPerSecond: Math.round(dWrites / elapsed),
        cache: {
            hitRatioPct:                  windowHitPct != null ? Number(windowHitPct.toFixed(2)) : null,
            pagesRequestedPerSec:         Math.round(dPagesReq  / elapsed),
            pagesReadIntoCachePerSec:     Math.round(dPagesRead / elapsed),
            pagesWrittenFromCachePerSec:  Math.round(dPagesWrit / elapsed),
            unmodifiedPagesEvictedPerSec: Math.round(dEvictUnmod / elapsed),
            modifiedPagesEvictedPerSec:   Math.round(dEvictMod  / elapsed),
            bytesCurrentlyInCacheEnd:     wtAfter.bytesCurrentlyInCache,
            trackedDirtyBytesEnd:         wtAfter.trackedDirtyBytes
        },
        byNamespace:            byNamespace,
        byNamespaceNote:        byNamespaceNote,
        systemNamespaceTotals:  systemNamespaceTotals,
        reconciliation: byNamespace ? {
            opcountersWritesPerSec:           +totalWritesRate.toFixed(2),
            topAccountedWritesPerSec:         +writeAccounted.toFixed(2),
            unaccountedWritesPerSec:          +(totalWritesRate - writeAccounted).toFixed(2),
            opcountersReadsPerSec:            +totalReadsRate.toFixed(2),
            topAccountedReadsPerSec:          +readAccounted.toFixed(2),
            unaccountedReadsPerSec:           +(totalReadsRate - readAccounted).toFixed(2),
            note: "opcounters counts every insert/update/delete; top() per-namespace counts only single-document writes. Bulk writes, insertMany, findAndModify, and time-series inserts are reported by top() as 'commands' on the target namespace (often under-attributed). A large unaccounted gap typically indicates bulk/TS workloads or Atlas-internal maintenance writers."
        } : null
    };
    print("✓ Operations metrics collected (lifetime + " + Math.round(elapsed) + "s windowed sample, incl. WT cache pressure" +
          (byNamespace ? ", per-namespace top() deltas" : "") + ")");
} else {
    print("\n· Windowed ops sample SKIPPED (OPS_SAMPLE_WINDOW_SECONDS = 0). lifetimeAverage only.");
}

// ============================================
// Replication metrics: oplog window + per-member lag
// ============================================
// Captured against the locally connected node. Useful sizing inputs:
//   - oplog.timeDiffHours below ~24h on a write-heavy workload suggests
//     the oplog is undersized for recovery / initial-sync windows.
//   - lagSeconds on any secondary indicates replication can't keep up
//     with primary writes (often a tier or network bottleneck).
report.replicationInfo = (function() {
    var out = { topology: "unknown" };
    var topoProbe = null;
    try { topoProbe = db.runCommand({ isMaster: 1 }); } catch (te) { /* ignore */ }
    if (topoProbe && topoProbe.msg === "isdbgrid") {
        out.topology = "sharded";
        out.note = "Connected via mongos; oplog and replication lag are per-shard. Run against each shard's primary for per-shard detail.";
        return out;
    }
    if (topoProbe && !topoProbe.setName) {
        out.topology = "standalone";
        out.note = "Standalone deployment; no oplog or replication.";
        return out;
    }
    out.topology = "replicaSet";
    out.setName  = topoProbe && topoProbe.setName;
    try {
        var ri = db.getReplicationInfo();
        out.oplog = {
            logSizeMB:     ri.logSizeMB,
            usedMB:        ri.usedSizeMB != null ? ri.usedSizeMB : ri.usedMB,
            timeDiffHours: ri.timeDiffHours,
            tFirst:        ri.tFirst,
            tLast:         ri.tLast
        };
    } catch (oe) {
        out.oplogError = (oe && oe.message) ? oe.message : String(oe);
    }
    try {
        var rs = db.adminCommand({ replSetGetStatus: 1 });
        if (rs && rs.members) {
            var primary = null;
            rs.members.forEach(function(m) { if (m.stateStr === "PRIMARY") primary = m; });
            var primaryOptime = primary && primary.optimeDate ? new Date(primary.optimeDate).getTime() : null;
            out.members = rs.members.map(function(m) {
                var memberOptime = m.optimeDate ? new Date(m.optimeDate).getTime() : null;
                var lagSeconds = null;
                if (m.stateStr === "PRIMARY") {
                    lagSeconds = 0;
                } else if (m.stateStr === "SECONDARY" && primaryOptime != null && memberOptime != null) {
                    lagSeconds = Math.max(0, Math.round((primaryOptime - memberOptime) / 1000));
                }
                return {
                    name:        m.name,
                    state:       m.stateStr,
                    health:      m.health,
                    optimeDate:  m.optimeDate,
                    lagSeconds:  lagSeconds
                };
            });
        }
    } catch (re) {
        out.replSetGetStatusError = (re && re.message) ? re.message : String(re);
    }
    return out;
})();
if (report.replicationInfo.topology === "replicaSet") {
    var ro = report.replicationInfo;
    var oplogHrs = ro.oplog ? ro.oplog.timeDiffHours : "?";
    print("✓ Replication info collected (oplog window " + oplogHrs + "h, " +
          (ro.members ? ro.members.length : 0) + " members).");
} else {
    print("· Replication info: " + (report.replicationInfo.note || report.replicationInfo.topology));
}

// ============================================
// OPTIONAL: Cluster-wide $indexStats union (scripts 04 / 05 inline)
// ============================================
if (COLLECT_CLUSTER_WIDE_INDEX_USAGE) {
    print("\n→ Cluster-wide index usage collection requested.");
    var topo = db.runCommand({ isMaster: 1 });
    var isSharded = (topo.msg === "isdbgrid");
    var topology = "standalone";
    var nodeList = [];

    if (isSharded) {
        topology = "sharded";
        db.getSiblingDB("config").shards.find().forEach(function(shard) {
            var slash = shard.host.indexOf("/");
            var hosts = (slash >= 0 ? shard.host.substring(slash + 1) : shard.host).split(",");
            hosts.forEach(function(h) { nodeList.push({ key: shard._id + "/" + h, host: h }); });
        });
    } else {
        var rsStatus = null;
        try { rsStatus = rs.status(); } catch (rse) { /* standalone */ }
        if (rsStatus && rsStatus.members) {
            topology = "replicaSet";
            rsStatus.members.filter(function(m) { return m.stateStr !== "ARBITER"; })
                .forEach(function(m) { nodeList.push({ key: m.name, host: m.name }); });
        } else {
            print("  Standalone deployment — skipping cluster-wide collection.");
        }
    }

    if (nodeList.length > 0) {
        print("  " + topology + " topology detected with " + nodeList.length + " data-bearing node(s).");
        var password = passwordPrompt();
        var indexMap = {};
        var nodesReached = [];

        nodeList.forEach(function(node) {
            var uri = "mongodb://" + encodeURIComponent(DIRECT_CONNECT_USERNAME) + ":" +
                      encodeURIComponent(password) + "@" + node.host +
                      "/?directConnection=true&authSource=" + DIRECT_CONNECT_AUTH_SOURCE +
                      (DIRECT_CONNECT_TLS ? "&tls=true" : "");
            var conn;
            try { conn = new Mongo(uri); }
            catch (ce) { print("  ✗ " + node.key + ": " + ce.message); return; }

            // Skip arbiters (isMaster works on 4.4 - 8.0)
            var localTopo;
            try { localTopo = conn.getDB("admin").runCommand({ isMaster: 1 }); } catch (he) { localTopo = {}; }
            if (localTopo.arbiterOnly) { return; }
            nodesReached.push(node.key);

            // Per-member hardware / resource snapshot
            try {
                var nodeSs = conn.getDB("admin").runCommand({ serverStatus: 1 });
                var nodeHi = conn.getDB("admin").runCommand({ hostInfo: 1 });
                var nodeSnap = collectHostSnapshot(nodeSs, nodeHi);
                nodeSnap.nodeKey = node.key;
                nodeSnap.role    = localTopo.ismaster ? "PRIMARY" : "SECONDARY";
                report.clusterInfo.nodes.push(nodeSnap);
            } catch (hse) {
                report.clusterInfo.nodes.push({
                    nodeKey: node.key,
                    error: "hostInfo/serverStatus failed: " + hse.message
                });
            }

            var dbList = conn.getDB("admin").runCommand({ listDatabases: 1 }).databases || [];
            dbList.forEach(function(database) {
                if (["admin", "local", "config"].indexOf(database.name) !== -1) return;
                var d = conn.getDB(database.name);
                d.getCollectionNames().forEach(function(collName) {
                    var cursor;
                    try { cursor = d.getCollection(collName).aggregate([{ $indexStats: {} }]); }
                    catch (ie) { return; }
                    cursor.forEach(function(u) {
                        var ns = database.name + "." + collName;
                        var key = ns + "::" + u.name;
                        if (!indexMap[key]) {
                            indexMap[key] = { ns: ns, name: u.name, key: u.key, perNode: {}, totalOps: 0 };
                        }
                        indexMap[key].perNode[node.key] = {
                            ops: u.accesses.ops.toString(),
                            since: u.accesses.since
                        };
                        indexMap[key].totalOps += Number(u.accesses.ops);
                    });
                });
            });
        });

        var indexes = Object.keys(indexMap).map(function(k) {
            var entry = indexMap[k];
            entry.observedOnNodes = Object.keys(entry.perNode).length;
            // Sharded: zero ops on every node where the index exists.
            // Replica set: zero ops AND observed on every reachable node.
            entry.unusedEverywhere = entry.totalOps === 0 && (
                topology === "sharded"
                    ? entry.observedOnNodes > 0
                    : entry.observedOnNodes === nodesReached.length
            );
            return entry;
        });
        indexes.sort(function(a, b) {
            if (a.unusedEverywhere !== b.unusedEverywhere) return a.unusedEverywhere ? -1 : 1;
            return a.totalOps - b.totalOps;
        });
        var unused = indexes.filter(function(i) { return i.unusedEverywhere && i.name !== "_id_"; });

        report.indexUsageClusterWide = {
            topology: topology,
            nodesReached: nodesReached,
            nodesTotal: nodeList.length,
            summary: {
                totalIndexesAnalyzed: indexes.length,
                unusedEverywhereCount: unused.length
            },
            unusedEverywhere: unused.map(function(i) { return { ns: i.ns, name: i.name, key: i.key }; }),
            indexes: indexes
        };
        print("✓ Cluster-wide index usage collected (" + nodesReached.length + "/" + nodeList.length + " nodes).");
    }
} else {
    print("\n· Cluster-wide index usage NOT collected " +
          "(set COLLECT_CLUSTER_WIDE_INDEX_USAGE = true to enable).");
}

// Summary
print("\n" + "=".repeat(60));
print("COLLECTION COMPLETE - SUMMARY");
print("=".repeat(60));
print("\nMongoDB Version: " + report.mongoVersion);
print("Storage Engine: " + report.clusterInfo.storageEngine);

var ls = report.clusterInfo.localSnapshot;
if (ls) {
    print("\nLocal Node Hardware (" + (ls.hostname || "unknown") + "):");
    print("  CPU cores (logical/physical): " + ls.system.cpuCores +
          " / " + (ls.system.numPhysicalCores != null ? ls.system.numPhysicalCores : "n/a"));
    print("  Memory:                       " + ls.system.memSizeMB + " MB total" +
          (ls.system.memLimitMB ? " (" + ls.system.memLimitMB + " MB cgroup limit)" : ""));
    print("  Resident memory:              " + (ls.memory.residentMB != null ? ls.memory.residentMB + " MB" : "n/a"));
    if (ls.wiredTigerCache.maxBytesConfigured) {
        print("  WT cache configured:          " +
              Math.round(ls.wiredTigerCache.maxBytesConfigured / 1024 / 1024) + " MB");
        print("  WT cache in use:              " +
              Math.round((ls.wiredTigerCache.bytesCurrentlyInCache || 0) / 1024 / 1024) + " MB");
    }
    print("  Connections (current/avail):  " + (ls.connections.current || 0) +
          " / " + (ls.connections.available || 0));
    print("  Uptime:                       " + ls.uptimeSeconds + " s");
    print("  Disk info:                    not collected (see report.clusterInfo.diskInfo.note)");
}
if (report.clusterInfo.nodes && report.clusterInfo.nodes.length > 0) {
    print("\nPer-Node Hardware Snapshots: " + report.clusterInfo.nodes.length +
          " node(s) captured in report.clusterInfo.nodes[]");
}

print("\nData Metrics:");
print("  Total Data Size: " + report.dataMetrics.totalDataSizeGB + " GB");
print("  Total Documents: " + report.dataMetrics.totalDocuments);
print("  Avg Document Size: " + report.dataMetrics.avgDocSizeKB + " KB");
print("  Compression: " + report.dataMetrics.compressionPct + "%");
print("  Total Indexes: " + report.dataMetrics.totalIndexCount);
print("  Total Index Size: " + report.dataMetrics.totalIndexSizeMB + " MB");
print("  Unused Secondary Indexes: " + report.dataMetrics.unusedIndexCount +
      " (" + report.dataMetrics.unusedIndexSizeMB + " MB reclaimable)");
print("  Max Secondary Indexes (single collection): " + report.dataMetrics.maxSecondaryIndexes);

if (report.indexUsageClusterWide) {
    var cw = report.indexUsageClusterWide;
    print("\nCluster-Wide Index Usage (" + cw.topology + "):");
    print("  Nodes reached:        " + cw.nodesReached.length + " / " + cw.nodesTotal);
    print("  Indexes analyzed:     " + cw.summary.totalIndexesAnalyzed);
    print("  Unused on EVERY node: " + cw.summary.unusedEverywhereCount);
    if (cw.nodesReached.length < cw.nodesTotal) {
        print("  ⚠ Some members were unreachable — 'unusedEverywhere' may be optimistic.");
    }
}

print("\nOperations Metrics:");
var la = report.operationsMetrics.lifetimeAverage;
print("  Lifetime average (uptime " + la.uptimeSeconds + "s):");
print("    Read Ops/sec:  " + la.readOpsPerSecond);
print("    Write Ops/sec: " + la.writeOpsPerSecond);
if (la.cacheHitRatioPct != null) {
    print("    WT cache hit ratio (lifetime): " + la.cacheHitRatioPct + "%");
}
print("    ⚠ " + la.warning);
var ws = report.operationsMetrics.windowedSample;
if (ws) {
    print("  Windowed sample (" + Math.round(ws.windowSecondsMeasured) + "s, requested " +
          ws.windowSecondsRequested + "s):");
    print("    Read Ops/sec:  " + ws.readOpsPerSecond);
    print("    Write Ops/sec: " + ws.writeOpsPerSecond);
    if (ws.cache) {
        print("    WT cache hit ratio:        " +
              (ws.cache.hitRatioPct != null ? ws.cache.hitRatioPct + "%" : "n/a (no cache activity in window)"));
        print("    Pages read into cache/s:   " + ws.cache.pagesReadIntoCachePerSec +
              "  (lower is better; non-zero indicates cache misses)");
        print("    Pages written from cache/s: " + ws.cache.pagesWrittenFromCachePerSec);
        print("    Pages evicted/s (mod/unmod): " + ws.cache.modifiedPagesEvictedPerSec +
              " / " + ws.cache.unmodifiedPagesEvictedPerSec);
    }
    if (ws.byNamespace && ws.byNamespace.length > 0) {
        // Suppress sub-1-op/s noise in the summary; the full list with
        // fractional values remains in the JSON report.
        var topRows = ws.byNamespace.filter(function(r) { return r.totalOpsPerSec >= 1; });
        if (topRows.length > 0) {
            print("    Top namespaces by ops/sec (full list incl. <1 ops/s in report.operationsMetrics.windowedSample.byNamespace):");
            topRows.slice(0, 5).forEach(function(r) {
                print("      " + r.ns + ": " + r.totalOpsPerSec + " ops/s (r=" +
                      r.readOpsPerSec + ", w=" + r.writeOpsPerSec + ", cmd=" + r.commandOpsPerSec + ")");
            });
            if (topRows.length > 5) {
                print("      … " + (topRows.length - 5) + " more with ≥1 ops/s (see byNamespace[])");
            }
        } else {
            print("    No user namespace exceeded 1 op/s in the window (see byNamespace[] for sub-1 ops/s detail).");
        }
        if (ws.systemNamespaceTotals) {
            var st = ws.systemNamespaceTotals;
            print("    System namespaces (admin/config/local — oplog, sessions, transactions):");
            print("      total: " + (st.readOpsPerSec + st.writeOpsPerSec + st.commandOpsPerSec).toFixed(2) +
                  " ops/s (r=" + st.readOpsPerSec + ", w=" + st.writeOpsPerSec + ", cmd=" + st.commandOpsPerSec + ")");
        }
        if (ws.reconciliation) {
            var rc = ws.reconciliation;
            // Only print the reconciliation line if there is a meaningful gap
            // (>5% or >5 ops/s). Small gaps are normal rounding noise.
            var gapW = rc.unaccountedWritesPerSec;
            var gapR = rc.unaccountedReadsPerSec;
            var sigW = Math.abs(gapW) > 5 || (rc.opcountersWritesPerSec > 0 && Math.abs(gapW) / rc.opcountersWritesPerSec > 0.05);
            var sigR = Math.abs(gapR) > 5 || (rc.opcountersReadsPerSec  > 0 && Math.abs(gapR) / rc.opcountersReadsPerSec  > 0.05);
            if (sigW || sigR) {
                print("    Reconciliation (opcounters vs top() — see windowedSample.reconciliation):");
                if (sigW) {
                    print("      writes: opcounters=" + rc.opcountersWritesPerSec +
                          "/s, top()=" + rc.topAccountedWritesPerSec +
                          "/s → unaccounted=" + gapW + "/s (likely bulk/TS/internal writers)");
                }
                if (sigR) {
                    print("      reads:  opcounters=" + rc.opcountersReadsPerSec +
                          "/s, top()=" + rc.topAccountedReadsPerSec +
                          "/s → unaccounted=" + gapR + "/s");
                }
            }
        }
    } else if (ws.byNamespaceNote) {
        print("    Per-namespace breakdown: " + ws.byNamespaceNote);
    }
} else {
    print("  Windowed sample: skipped (OPS_SAMPLE_WINDOW_SECONDS = 0).");
}

if (report.replicationInfo) {
    var ri = report.replicationInfo;
    print("\nReplication Info (" + ri.topology +
          (ri.setName ? ", set=" + ri.setName : "") + "):");
    if (ri.oplog) {
        print("  Oplog size:         " + ri.oplog.logSizeMB + " MB" +
              (ri.oplog.usedMB != null ? " (" + Math.round(ri.oplog.usedMB) + " MB used)" : ""));
        print("  Oplog window:       " + ri.oplog.timeDiffHours + " h" +
              (ri.oplog.timeDiffHours != null && ri.oplog.timeDiffHours < 24
                  ? "  ⚠ < 24h; consider increasing oplog size for safer recovery / initial sync"
                  : ""));
    } else if (ri.oplogError) {
        print("  Oplog:              error: " + ri.oplogError);
    }
    if (ri.members && ri.members.length > 0) {
        var maxLag = 0;
        ri.members.forEach(function(m) {
            if (m.lagSeconds != null && m.lagSeconds > maxLag) maxLag = m.lagSeconds;
        });
        print("  Members:            " + ri.members.length);
        print("  Max secondary lag:  " + maxLag + " s" +
              (maxLag > 10 ? "  ⚠ secondary is lagging; investigate write rate vs tier capacity" : ""));
        ri.members.forEach(function(m) {
            print("    " + m.name + " [" + m.state + "]" +
                  (m.lagSeconds != null ? " lag=" + m.lagSeconds + "s" : ""));
        });
    } else if (ri.note) {
        print("  " + ri.note);
    }
}

if (report.dataMetrics.skippedCollections && report.dataMetrics.skippedCollections.length > 0) {
    print("\nSkipped Collections: " + report.dataMetrics.skippedCollections.length +
          " (see report.dataMetrics.skippedCollections[] for reasons)");
}

print("\n" + "=".repeat(60));
print("FULL REPORT (save this output):");
print("=".repeat(60) + "\n");
printjson(report);

print("\n" + "=".repeat(60));
print("NEXT STEPS:");
print("=".repeat(60));
print("1. Save this output to a file");
print("2. Run this script during PEAK HOURS for accurate ops metrics");
print("3. Provide this data to your MongoDB sizing consultant");
print("4. Answer the workload questionnaire questions");
print("=".repeat(60) + "\n");
