// ============================================
// SCRIPT 4: Replica-Set-Wide $indexStats Aggregator
// Compatible with MongoDB 4.4 - 8.0
// ============================================
// Connects directly to every reachable, data-bearing member of the
// replica set, runs $indexStats per user collection, and unions the
// results so an index marked "unused" reflects every node.
//
// Edit USERNAME, AUTH_SOURCE and TLS below as appropriate. Password
// is prompted (never written to disk or argv).
//
// NOTE: Sharded clusters (mongos) are not supported by this script —
// rs.status() is unavailable there. Run it against each shard's
// primary individually instead.
// ============================================
var USERNAME    = "sizingUser";
var AUTH_SOURCE = "admin";
var TLS         = true; // Atlas requires TLS

var status;
try {
    status = rs.status();
} catch (e) {
    print("✗ rs.status() failed: " + e.message);
    print("  This script requires a replica set. For sharded clusters,");
    print("  connect directly to each shard's primary and re-run.");
    quit(1);
}

var password = passwordPrompt();

// Collect data-bearing members (skip arbiters)
var members = status.members.filter(function(m) {
    return m.stateStr !== "ARBITER";
}).map(function(m) {
    return { host: m.name, stateStr: m.stateStr };
});

print("\n========================================");
print("Replica set: " + status.set);
print("Data-bearing members: " + members.length);
members.forEach(function(m) { print("  - " + m.host + " (" + m.stateStr + ")"); });
print("========================================\n");

// indexKey -> { ns, name, key, perNode: {host: {ops, since}}, totalOps, sumIfUsed }
var indexMap = {};
var nodesReached = [];

members.forEach(function(m) {
    var uri = "mongodb://" + encodeURIComponent(USERNAME) + ":" +
              encodeURIComponent(password) + "@" + m.host +
              "/?directConnection=true&authSource=" + AUTH_SOURCE +
              (TLS ? "&tls=true" : "");
    var conn;
    try {
        conn = new Mongo(uri);
    } catch (ce) {
        print("✗ Could not connect to " + m.host + ": " + ce.message);
        return;
    }
    nodesReached.push(m.host);
    print("→ Collecting from " + m.host + " (" + m.stateStr + ")");

    var adminDb = conn.getDB("admin");
    var dbList  = adminDb.runCommand({ listDatabases: 1 }).databases;
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
                indexMap[key].perNode[m.host] = {
                    ops: u.accesses.ops.toString(),
                    since: u.accesses.since
                };
                indexMap[key].totalOps += ops;
            });
        });
    });
});

// Build report
var indexes = Object.keys(indexMap).map(function(k) {
    var entry = indexMap[k];
    var observedOn = Object.keys(entry.perNode);
    entry.observedOnNodes = observedOn.length;
    entry.unusedEverywhere = entry.totalOps === 0 && observedOn.length === nodesReached.length;
    return entry;
});

// Sort: unused-everywhere first, then by totalOps asc (coldest first)
indexes.sort(function(a, b) {
    if (a.unusedEverywhere !== b.unusedEverywhere) return a.unusedEverywhere ? -1 : 1;
    return a.totalOps - b.totalOps;
});

var unusedEverywhere = indexes.filter(function(i) {
    return i.unusedEverywhere && i.name !== "_id_";
});

var report = {
    replicaSet: status.set,
    nodesReached: nodesReached,
    nodesTotal: members.length,
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
print("Replica set:           " + report.replicaSet);
print("Nodes reached:         " + nodesReached.length + " / " + members.length);
print("Indexes analyzed:      " + report.summary.totalIndexesAnalyzed);
print("Unused on EVERY node:  " + report.summary.unusedEverywhereCount);
if (nodesReached.length < members.length) {
    print("⚠ Some members were unreachable — 'unusedEverywhere' may be optimistic.");
}
print("\n========================================");
print("FULL REPORT (save this output):");
print("========================================");
printjson(report);
