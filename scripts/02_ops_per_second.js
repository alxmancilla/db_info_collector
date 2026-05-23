// ============================================
// SCRIPT 2: Operations Per Second Measurement
// Compatible with MongoDB 4.4 - 8.0
// ============================================
// Windowed sample length. 60s averages out sub-minute bursts; drop to
// 10-30s for steady workloads. Set to 0 to skip the sample and emit
// lifetimeAverage only (no wait).
var OPS_SAMPLE_WINDOW_SECONDS = 60;

print("\n========================================");
print("Operations Per Second Measurement");
print("MongoDB Version: " + db.version());
print("========================================\n");

// opcounters values are BSON Long; the `+` operator on Long invokes
// Symbol.toPrimitive("default") which returns toString(), producing
// string concatenation instead of numeric addition. Force Number()
// on every counter before any arithmetic.
function opNum(v) { return v == null ? 0 : Number(v); }

// Helper: per-namespace usage counters via db.adminCommand({top: 1}).
// Returns null on mongos (top is mongod-only).
function topSnapshot() {
    try {
        var res = db.adminCommand({ top: 1 });
        if (!res || !res.totals) return null;
        var out = {};
        Object.keys(res.totals).forEach(function(ns) {
            var t = res.totals[ns];
            if (!t || typeof t !== "object") return;
            out[ns] = {
                reads:    opNum(t.queries && t.queries.count) + opNum(t.getmore && t.getmore.count),
                writes:   opNum(t.insert  && t.insert.count)
                        + opNum(t.update  && t.update.count)
                        + opNum(t.remove  && t.remove.count),
                commands: opNum(t.commands && t.commands.count)
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
var ssLifetime = db.serverStatus();
var lifeOc     = ssLifetime.opcounters;
var lifeUptime = opNum(ssLifetime.uptime);
var lifeReads  = opNum(lifeOc.query)  + opNum(lifeOc.getmore);
var lifeWrites = opNum(lifeOc.insert) + opNum(lifeOc.update) + opNum(lifeOc.delete);
var opsData = {
    mongoVersion: db.version(),
    timestamp:    new Date(),
    lifetimeAverage: {
        uptimeSeconds:     lifeUptime,
        readOpsPerSecond:  lifeUptime > 0 ? Math.round(lifeReads  / lifeUptime) : 0,
        writeOpsPerSecond: lifeUptime > 0 ? Math.round(lifeWrites / lifeUptime) : 0,
        warning: "Average since process start; includes idle hours, restarts, migrations. Do NOT use for peak sizing."
    },
    atlasApiNote: "For Atlas clusters, the canonical peak input is the Atlas Metrics API: " +
                  "processMeasurements?granularity=PT1M&metrics=OPCOUNTER_QUERY,OPCOUNTER_INSERT,OPCOUNTER_UPDATE,OPCOUNTER_DELETE,OPCOUNTER_GETMORE " +
                  "over a 7-day window, then take MAX()."
};

if (OPS_SAMPLE_WINDOW_SECONDS > 0) {
    print("Measuring operations over " + OPS_SAMPLE_WINDOW_SECONDS + " seconds...\n");
    var before     = db.serverStatus().opcounters;
    var topBefore  = topSnapshot();
    var beforeTime = new Date();
    sleep(OPS_SAMPLE_WINDOW_SECONDS * 1000);
    var after      = db.serverStatus().opcounters;
    var topAfter   = topSnapshot();
    var afterTime  = new Date();
    var elapsed    = (afterTime - beforeTime) / 1000; // measured, not assumed

    var dQuery   = opNum(after.query)   - opNum(before.query);
    var dGetmore = opNum(after.getmore) - opNum(before.getmore);
    var dInsert  = opNum(after.insert)  - opNum(before.insert);
    var dUpdate  = opNum(after.update)  - opNum(before.update);
    var dDelete  = opNum(after.delete)  - opNum(before.delete);

    // Per-namespace breakdown via top() deltas. Splits user vs system
    // namespaces so the report can reconcile against opcounters (oplog
    // and session writes on local.*/admin.*/config.* often dominate).
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
    // sums. top() reports bulk/insertMany/TS-insert/findAndModify under
    // commands rather than insert/update/remove, so a large gap is
    // expected on workloads dominated by those operations.
    var nsWriteSum = 0, nsReadSum = 0;
    if (byNamespace) {
        byNamespace.forEach(function(r) {
            nsWriteSum += r.writeOpsPerSec;
            nsReadSum  += r.readOpsPerSec;
        });
    }
    var sysWrites = systemNamespaceTotals ? systemNamespaceTotals.writeOpsPerSec : 0;
    var sysReads  = systemNamespaceTotals ? systemNamespaceTotals.readOpsPerSec  : 0;
    var totalWritesRate = (dInsert + dUpdate + dDelete) / elapsed;
    var totalReadsRate  = (dQuery  + dGetmore)          / elapsed;
    var writeAccounted  = nsWriteSum + sysWrites;
    var readAccounted   = nsReadSum  + sysReads;

    opsData.windowedSample = {
        windowSecondsRequested: OPS_SAMPLE_WINDOW_SECONDS,
        windowSecondsMeasured:  elapsed,
        readOps: {
            query:     dQuery,
            getmore:   dGetmore,
            total:     dQuery + dGetmore,
            perSecond: Math.round((dQuery + dGetmore) / elapsed)
        },
        writeOps: {
            insert:    dInsert,
            update:    dUpdate,
            delete:    dDelete,
            total:     dInsert + dUpdate + dDelete,
            perSecond: Math.round((dInsert + dUpdate + dDelete) / elapsed)
        },
        byNamespace:            byNamespace,
        byNamespaceNote:        byNamespaceNote,
        systemNamespaceTotals:  systemNamespaceTotals,
        reconciliation: byNamespace ? {
            opcountersWritesPerSec:   +totalWritesRate.toFixed(2),
            topAccountedWritesPerSec: +writeAccounted.toFixed(2),
            unaccountedWritesPerSec:  +(totalWritesRate - writeAccounted).toFixed(2),
            opcountersReadsPerSec:    +totalReadsRate.toFixed(2),
            topAccountedReadsPerSec:  +readAccounted.toFixed(2),
            unaccountedReadsPerSec:   +(totalReadsRate - readAccounted).toFixed(2),
            note: "opcounters counts every insert/update/delete; top() per-namespace counts only single-document writes. Bulk writes, insertMany, findAndModify, and time-series inserts are reported by top() as 'commands' on the target namespace (often under-attributed). A large unaccounted gap typically indicates bulk/TS workloads or Atlas-internal maintenance writers."
        } : null
    };
}

print("========================================");
print("RESULTS:");
print("========================================");
print("Lifetime average (uptime " + opsData.lifetimeAverage.uptimeSeconds + "s):");
print("  Read Ops/sec:  " + opsData.lifetimeAverage.readOpsPerSecond);
print("  Write Ops/sec: " + opsData.lifetimeAverage.writeOpsPerSecond);
print("  ⚠ " + opsData.lifetimeAverage.warning);
if (opsData.windowedSample) {
    var wsOut = opsData.windowedSample;
    print("Windowed sample (" + Math.round(wsOut.windowSecondsMeasured) + "s):");
    print("  Read Ops/sec:  " + wsOut.readOps.perSecond);
    print("  Write Ops/sec: " + wsOut.writeOps.perSecond);
    if (wsOut.byNamespace && wsOut.byNamespace.length > 0) {
        var topRows = wsOut.byNamespace.filter(function(r) { return r.totalOpsPerSec >= 1; });
        if (topRows.length > 0) {
            print("  Top namespaces by ops/sec (full list incl. <1 ops/s in opsData.windowedSample.byNamespace):");
            topRows.slice(0, 5).forEach(function(r) {
                print("    " + r.ns + ": " + r.totalOpsPerSec + " ops/s (r=" +
                      r.readOpsPerSec + ", w=" + r.writeOpsPerSec + ", cmd=" + r.commandOpsPerSec + ")");
            });
            if (topRows.length > 5) {
                print("    … " + (topRows.length - 5) + " more with ≥1 ops/s (see byNamespace[])");
            }
        } else {
            print("  No user namespace exceeded 1 op/s in the window (see byNamespace[] for sub-1 ops/s detail).");
        }
        if (wsOut.systemNamespaceTotals) {
            var st = wsOut.systemNamespaceTotals;
            print("  System namespaces (admin/config/local — oplog, sessions, transactions):");
            print("    total: " + (st.readOpsPerSec + st.writeOpsPerSec + st.commandOpsPerSec).toFixed(2) +
                  " ops/s (r=" + st.readOpsPerSec + ", w=" + st.writeOpsPerSec + ", cmd=" + st.commandOpsPerSec + ")");
        }
        if (wsOut.reconciliation) {
            var rc = wsOut.reconciliation;
            var gapW = rc.unaccountedWritesPerSec;
            var gapR = rc.unaccountedReadsPerSec;
            var sigW = Math.abs(gapW) > 5 || (rc.opcountersWritesPerSec > 0 && Math.abs(gapW) / rc.opcountersWritesPerSec > 0.05);
            var sigR = Math.abs(gapR) > 5 || (rc.opcountersReadsPerSec  > 0 && Math.abs(gapR) / rc.opcountersReadsPerSec  > 0.05);
            if (sigW || sigR) {
                print("  Reconciliation (opcounters vs top() — see opsData.windowedSample.reconciliation):");
                if (sigW) {
                    print("    writes: opcounters=" + rc.opcountersWritesPerSec +
                          "/s, top()=" + rc.topAccountedWritesPerSec +
                          "/s → unaccounted=" + gapW + "/s (likely bulk/TS/internal writers)");
                }
                if (sigR) {
                    print("    reads:  opcounters=" + rc.opcountersReadsPerSec +
                          "/s, top()=" + rc.topAccountedReadsPerSec +
                          "/s → unaccounted=" + gapR + "/s");
                }
            }
        }
    } else if (wsOut.byNamespaceNote) {
        print("  Per-namespace breakdown: " + wsOut.byNamespaceNote);
    }
} else {
    print("Windowed sample: skipped (OPS_SAMPLE_WINDOW_SECONDS = 0).");
}
print("\nDetailed Breakdown:");
printjson(opsData);
