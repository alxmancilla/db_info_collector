// ============================================
// SCRIPT 5: Sharded-Cluster $indexStats Aggregator
// Compatible with MongoDB 4.4 - 8.0
// ============================================
// Connects directly to every reachable, data-bearing member of every
// shard (each shard is itself a replica set), runs $indexStats per
// user collection, and unions the results across the entire cluster.
//
// Must be run while connected to a mongos. Edit USERNAME / AUTH_SOURCE
// / TLS as appropriate; password is prompted.
// ============================================
var USERNAME    = "sizingUser";
var AUTH_SOURCE = "admin";
var TLS         = true; // Atlas requires TLS

// Verify mongos (isMaster is supported 4.4 - 8.0; hello is 5.0+ only)
var topo = db.runCommand({ isMaster: 1 });
if (topo.msg !== "isdbgrid") {
    print("✗ Not connected to a mongos. For a single replica set, use");
    print("  scripts/04_index_usage_all_nodes.js instead.");
    quit(1);
}

var password = passwordPrompt();

// Discover shards from the config database
var shards = db.getSiblingDB("config").shards.find().toArray();
print("\n========================================");
print("Sharded cluster discovered");
print("Shards: " + shards.length);
shards.forEach(function(s) { print("  - " + s._id + " -> " + s.host); });
print("========================================\n");

// Parse "rsName/host1:port,host2:port,..." into a member list
function parseShardHosts(hostString) {
    var slash = hostString.indexOf("/");
    var list  = slash >= 0 ? hostString.substring(slash + 1) : hostString;
    return list.split(",");
}

// indexKey -> { ns, name, key, perNode: {shard/host: {ops, since}}, totalOps }
var indexMap     = {};
var nodesReached = [];
var nodesTotal   = 0;
var shardsReached = {};

shards.forEach(function(shard) {
    var hosts = parseShardHosts(shard.host);
    hosts.forEach(function(host) {
        nodesTotal++;
        var uri = "mongodb://" + encodeURIComponent(USERNAME) + ":" +
                  encodeURIComponent(password) + "@" + host +
                  "/?directConnection=true&authSource=" + AUTH_SOURCE +
                  (TLS ? "&tls=true" : "");
        var conn;
        try {
            conn = new Mongo(uri);
        } catch (ce) {
            print("✗ Could not connect to " + shard._id + "/" + host + ": " + ce.message);
            return;
        }

        // Skip arbiters (no data). isMaster works on 4.4 - 8.0.
        var localTopo;
        try { localTopo = conn.getDB("admin").runCommand({ isMaster: 1 }); } catch (he) { localTopo = {}; }
        if (localTopo.arbiterOnly) {
            print("· Skipping arbiter " + shard._id + "/" + host);
            return;
        }

        var nodeKey = shard._id + "/" + host;
        nodesReached.push(nodeKey);
        shardsReached[shard._id] = true;
        print("→ " + nodeKey + " (" + (localTopo.ismaster ? "PRIMARY" : "SECONDARY") + ")");

        var adminDb = conn.getDB("admin");
        var dbList  = adminDb.runCommand({ listDatabases: 1 }).databases || [];
        dbList.forEach(function(database) {
            if (["admin", "local", "config"].indexOf(database.name) !== -1) return;
            var d = conn.getDB(database.name);
            d.getCollectionNames().forEach(function(collName) {
                var cursor;
                try {
                    cursor = d.getCollection(collName).aggregate([{ $indexStats: {} }]);
                } catch (ie) {
                    return; // views, etc.
                }
                cursor.forEach(function(u) {
                    var ns  = database.name + "." + collName;
                    var key = ns + "::" + u.name;
                    if (!indexMap[key]) {
                        indexMap[key] = {
                            ns: ns,
                            name: u.name,
                            key: u.key,
                            perNode: {},
                            totalOps: 0
                        };
                    }
                    var ops = Number(u.accesses.ops);
                    indexMap[key].perNode[nodeKey] = {
                        ops: u.accesses.ops.toString(),
                        since: u.accesses.since
                    };
                    indexMap[key].totalOps += ops;
                });
            });
        });
    });
});

// Build report
var indexes = Object.keys(indexMap).map(function(k) {
    var entry = indexMap[k];
    var observedOn = Object.keys(entry.perNode);
    entry.observedOnNodes = observedOn.length;
    // Sharded collections live on a subset of shards, so equality with
    // nodesReached.length would be wrong; require zero ops on every node
    // where the index is observed.
    entry.unusedEverywhere = entry.totalOps === 0 && observedOn.length > 0;
    return entry;
});

indexes.sort(function(a, b) {
    if (a.unusedEverywhere !== b.unusedEverywhere) return a.unusedEverywhere ? -1 : 1;
    return a.totalOps - b.totalOps;
});

var unusedEverywhere = indexes.filter(function(i) {
    return i.unusedEverywhere && i.name !== "_id_";
});

var report = {
    clusterType: "sharded",
    shardsTotal: shards.length,
    shardsReached: Object.keys(shardsReached).length,
    nodesReached: nodesReached,
    nodesTotal: nodesTotal,
    collectedAt: new Date(),
    summary: {
        totalIndexesAnalyzed: indexes.length,
        unusedEverywhereCount: unusedEverywhere.length
    },
    unusedEverywhere: unusedEverywhere.map(function(i) {
        return { ns: i.ns, name: i.name, key: i.key };
    }),
    indexes: indexes
};

print("\n========================================");
print("SUMMARY");
print("========================================");
print("Shards reached:        " + report.shardsReached + " / " + report.shardsTotal);
print("Nodes reached:         " + nodesReached.length + " / " + nodesTotal);
print("Indexes analyzed:      " + report.summary.totalIndexesAnalyzed);
print("Unused on EVERY node:  " + report.summary.unusedEverywhereCount);
if (nodesReached.length < nodesTotal) {
    print("⚠ Some members were unreachable — 'unusedEverywhere' may be optimistic.");
}
print("\n========================================");
print("FULL REPORT (save this output):");
print("========================================");
printjson(report);
