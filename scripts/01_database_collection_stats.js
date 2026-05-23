// ============================================
// SCRIPT 1: Database and Collection Statistics
// Compatible with MongoDB 4.4 - 8.0
// ============================================

// Per-node hardware / resource snapshot (mirrors collect_sizing_data.js
// so the granular path captures the same fields).
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
            // Cumulative counters since mongod start; lifetime hit ratio =
            // 1 - (pagesReadIntoCache / pagesRequestedFromCache).
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

var sizingData = {
    timestamp: new Date(),
    mongoVersion: db.version(),
    clusterInfo: {},
    totalDataSizeGB: 0,
    totalDocuments: 0,
    totalRawSizeKB: 0,
    totalCompressedSizeKB: 0,
    totalIndexSizeMB: 0,
    totalIndexCount: 0,
    unusedIndexCount: 0,
    unusedIndexSizeMB: 0,
    databases: []
};

// Cluster Information (locally connected node)
try {
    var localSnap = collectHostSnapshot(db.serverStatus(), db.hostInfo());
    sizingData.clusterInfo = {
        mongoVersion:  localSnap.mongoVersion,
        hostname:      localSnap.hostname,
        cpuCores:      localSnap.system.cpuCores,
        memSizeMB:     localSnap.system.memSizeMB,
        storageEngine: localSnap.storageEngine,
        localSnapshot: localSnap,
        diskInfo: {
            note: "Disk size, free space, and IOPS are not exposed by mongosh. " +
                  "For Atlas, pull from the Atlas API (processMeasurements: " +
                  "DISK_PARTITION_SPACE_FREE, DISK_PARTITION_IOPS_*). " +
                  "For self-hosted, record manually from df/lsblk on the dbPath volume."
        }
    };
} catch (e) {
    sizingData.clusterInfo = { error: "hostInfo/serverStatus failed: " + e.message };
}

print("\n========================================");
print("MongoDB Sizing Data Collection");
print("MongoDB Version: " + db.version());
print("========================================\n");
db.adminCommand({listDatabases: 1}).databases.forEach(function(database) {
    // Skip system databases
    if (database.name !== "admin" && database.name !== "local" && database.name !== "config") {
        print("Processing database: " + database.name);

        var dbObj = {
            name: database.name,
            sizeOnDiskMB: (database.sizeOnDisk / 1024 / 1024).toFixed(2),
            collections: []
        };

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
                // all; their real data lives on system.buckets.<coll> and
                // is processed separately. Bucket collections themselves
                // may lack `count` on 8.0 but still have size/storage —
                // accept those.
                if (!hasCount && !hasSize && !hasStorage) {
                    var bucketHint = isBucketColl
                        ? collName
                        : "system.buckets." + collName;
                    print("  · Skipping " + collName +
                          (stats.timeseries
                              ? " (time-series logical namespace; storage counted via " + bucketHint + ")"
                              : " (view or no stats)"));
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
                        sizeKB: (sizeBytes / 1024).toFixed(2),
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

                var collData = {
                    name: collName,
                    documentCount: sCount,
                    dataSizeMB: (sSize / 1024 / 1024).toFixed(2),
                    avgDocSizeKB: (sAvgObjSize / 1024).toFixed(2),
                    storageSizeMB: (sStorage / 1024 / 1024).toFixed(2),
                    totalIndexSizeMB: (sTotalIdx / 1024 / 1024).toFixed(2),
                    indexCount: sNindexes, // Includes _id index
                    secondaryIndexCount: sNindexes - 1, // Excludes _id index
                    unusedSecondaryIndexCount: unusedInColl,
                    unusedSecondaryIndexSizeMB: unusedSizeMBInColl.toFixed(2),
                    indexes: indexDetails,
                    compressionRatio: sSize > 0 ? ((1 - (sStorage / sSize)) * 100).toFixed(2) + "%" : "N/A"
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
                    collData.timeseries = tsOut;
                }
                // Tag bucket collections so the link to the parent TS
                // namespace is explicit and documentCount is not misread
                // as measurement count (it is bucket count).
                if (collName.indexOf("system.buckets.") === 0) {
                    collData.isTimeseriesBucketStorage = true;
                    collData.parentTimeseriesNs = database.name + "." +
                        collName.substring("system.buckets.".length);
                    collData.docsMeaning = "bucket count (not measurement count)";
                }

                dbObj.collections.push(collData);

                // Aggregate totals
                sizingData.totalDocuments += sCount;
                sizingData.totalRawSizeKB += (sSize / 1024);
                sizingData.totalCompressedSizeKB += (sStorage / 1024);
                sizingData.totalIndexSizeMB += (sTotalIdx / 1024 / 1024);
                sizingData.totalIndexCount += sNindexes;
                sizingData.unusedIndexCount += unusedInColl;
                sizingData.unusedIndexSizeMB += unusedSizeMBInColl;

                print("  ✓ " + collName + " (" + sCount + " docs, " +
                      sNindexes + " indexes, " +
                      (sTotalIdx / 1024 / 1024).toFixed(2) + " MB index" +
                      (unusedInColl > 0 ? ", " + unusedInColl + " unused" : "") + ")");
            } catch (e) {
                print("  ✗ Error processing " + collName + ": " + e.message);
            }
        });

        sizingData.databases.push(dbObj);
    }
});
// Calculate overall metrics
sizingData.totalDataSizeGB = (sizingData.totalRawSizeKB / 1024 / 1024).toFixed(2);
sizingData.avgDocSizeKB = sizingData.totalDocuments > 0 ?
    (sizingData.totalRawSizeKB / sizingData.totalDocuments).toFixed(2) : 0;
sizingData.overallCompressionPct = sizingData.totalRawSizeKB > 0 ?
    ((1 - (sizingData.totalCompressedSizeKB / sizingData.totalRawSizeKB)) * 100).toFixed(2) + "%" : "N/A";
sizingData.totalIndexSizeMB = sizingData.totalIndexSizeMB.toFixed(2);
sizingData.unusedIndexSizeMB = sizingData.unusedIndexSizeMB.toFixed(2);
print("\n========================================");
print("SUMMARY");
print("========================================");
print("MongoDB Version: " + sizingData.mongoVersion);
print("Storage Engine: " + (sizingData.clusterInfo.storageEngine || "unknown"));

var ls = sizingData.clusterInfo.localSnapshot;
if (ls) {
    print("\nLocal Node Hardware (" + (ls.hostname || "unknown") + "):");
    print("  CPU cores (logical/physical): " + ls.system.cpuCores +
          " / " + (ls.system.numPhysicalCores != null ? ls.system.numPhysicalCores : "n/a"));
    print("  Memory:                       " + ls.system.memSizeMB + " MB total" +
          (ls.system.memLimitMB ? " (" + ls.system.memLimitMB + " MB cgroup limit)" : ""));
    print("  Resident memory:              " + (ls.memory.residentMB != null ? ls.memory.residentMB + " MB" : "n/a"));
    if (ls.wiredTigerCache.maxBytesConfigured) {
        print("  WT cache configured:          " +
              Math.round(Number(ls.wiredTigerCache.maxBytesConfigured) / 1024 / 1024) + " MB");
        print("  WT cache in use:              " +
              Math.round(Number(ls.wiredTigerCache.bytesCurrentlyInCache || 0) / 1024 / 1024) + " MB");
        var pReq  = Number(ls.wiredTigerCache.pagesRequestedFromCache || 0);
        var pRead = Number(ls.wiredTigerCache.pagesReadIntoCache      || 0);
        if (pReq > 0) {
            print("  WT cache hit ratio (lifetime): " +
                  (100 * (1 - pRead / pReq)).toFixed(2) + "%");
        }
    }
    print("  Connections (current/avail):  " + (ls.connections.current || 0) +
          " / " + (ls.connections.available || 0));
    print("  Uptime:                       " + ls.uptimeSeconds + " s");
    print("  Disk info:                    not collected (see clusterInfo.diskInfo.note)");
}

print("\nTotal Data Size: " + sizingData.totalDataSizeGB + " GB");
print("Total Documents: " + sizingData.totalDocuments);
print("Average Document Size: " + sizingData.avgDocSizeKB + " KB");
print("Overall Compression: " + sizingData.overallCompressionPct);
print("Total Indexes: " + sizingData.totalIndexCount);
print("Total Index Size: " + sizingData.totalIndexSizeMB + " MB");
print("Unused Secondary Indexes: " + sizingData.unusedIndexCount +
      " (" + sizingData.unusedIndexSizeMB + " MB reclaimable)");
print("Note: $indexStats counters are per-node and reset on restart/stepdown.");
print("\n");
// Output full JSON for record-keeping
print("========================================");
print("DETAILED OUTPUT (save this):");
print("========================================");
printjson(sizingData);
